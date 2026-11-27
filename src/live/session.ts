import type { FastifyRequest } from 'fastify';
import WebSocket from 'ws';
import { audit, type AppContext } from '../context.js';
import { buildVerifiedContext, type HouseholdContext } from '../ai/assistant.js';
import { emergencyResponse, isEmergencyMessage } from '../ai/emergency.js';
import { checkFreeText } from '../ai/safety.js';
import type { AirQualityResult } from '../google/service.js';
import {
  audioParts,
  caption,
  clientMsgSchema,
  MAX_CLIENT_MSGS_PER_SEC,
  sendJson,
  setupMessage,
  upstreamInput,
  type ClientMsg,
  type UpstreamMessage,
} from './protocol.js';

/** Server-side facts the voice model may use; built like the text assistant's context. */
export interface LiveContext {
  aq: AirQualityResult;
  household: HouseholdContext | null;
  regionCode: string | null;
}

export interface LiveSessionDeps {
  ctx: AppContext;
  req: FastifyRequest;
  userId: string;
  client: WebSocket;
  upstream: WebSocket;
  context: LiveContext;
  onClose: () => void;
}

/** Closing an already-closed socket can throw; that is fine here. */
const safely = (fn: () => void) => {
  try {
    fn();
  } catch {
    /* already closed */
  }
};

const BLOCKED_MESSAGE =
  'That answer was withheld by safety checks. Please ask again or use the text assistant.';

/**
 * One proxied voice conversation between the browser and Gemini Live. It enforces time limits, client
 * rate limits, emergency routing and the output safety policy. Only metadata is logged: no audio or text.
 */
export class LiveSession {
  readonly startedAt = Date.now();
  private closed = false;
  private lastClientAudio = Date.now();
  private turnText = '';
  private msgCount = 0;
  private windowStart = Date.now();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly d: LiveSessionDeps) {
    const { live } = d.ctx.config;
    this.timer = setInterval(() => this.checkLimits(live.maxSessionSeconds, live.idleTimeoutSeconds), 1000);
    this.timer.unref();
    d.upstream.on('open', () => d.upstream.send(this.setup()));
    d.upstream.on('message', (raw: WebSocket.RawData) => this.onUpstream(raw));
    d.upstream.on('close', () => this.finish('upstream_closed'));
    d.upstream.on('error', () => this.finish('upstream_error')); // never forward upstream error text
    d.client.on('message', (raw: WebSocket.RawData, isBinary: boolean) => this.onClient(raw, isBinary));
    d.client.on('close', () => this.finish('client_closed', false));
    d.client.on('error', () => this.finish('client_error', false));
  }

  finish(reason: string, notify = true): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.d.onClose();
    if (notify) sendJson(this.d.client, { type: 'closed', reason });
    safely(() => this.d.upstream.close());
    safely(() => this.d.client.close(1000, reason.slice(0, 100)));
    this.d.req.log.info({ reason }, 'live voice session closed');
  }

  private setup(): string {
    const { aq, household } = this.d.context;
    const verified = buildVerifiedContext({ aq, household, now: this.d.ctx.now() });
    return setupMessage(this.d.ctx.config.live.liveModel!, verified);
  }

  private checkLimits(maxSeconds: number, idleSeconds: number): void {
    const now = Date.now();
    if (now - this.startedAt > maxSeconds * 1000) this.finish('max_duration');
    else if (now - this.lastClientAudio > idleSeconds * 1000) this.finish('idle_timeout');
  }

  private onUpstream(raw: WebSocket.RawData): void {
    if (this.closed) return;
    let m: UpstreamMessage;
    try {
      m = JSON.parse(raw.toString()) as UpstreamMessage;
    } catch {
      return;
    }
    if (m.setupComplete) this.sendReady();
    else if (m.serverContent) this.onServerContent(m.serverContent);
  }

  private onServerContent(sc: NonNullable<UpstreamMessage['serverContent']>): void {
    const userText = sc.inputTranscription?.text;
    if (userText && !this.onUserSpeech(userText)) return;
    const modelText = sc.outputTranscription?.text;
    if (modelText && !this.onModelSpeech(modelText)) return;
    for (const a of audioParts(sc)) sendJson(this.d.client, { type: 'audio', ...a });
    if (sc.interrupted) this.endTurn('interrupted');
    if (sc.turnComplete) this.endTurn('turn_complete');
  }

  private sendReady(): void {
    const { live } = this.d.ctx.config;
    sendJson(this.d.client, {
      type: 'ready',
      maxSessionSeconds: live.maxSessionSeconds,
      idleTimeoutSeconds: live.idleTimeoutSeconds,
      airQualityStatus: this.d.context.aq.status,
    });
  }

  /** Returns false when the session ended because the user described an emergency. */
  private onUserSpeech(raw: string): boolean {
    const text = caption(raw);
    sendJson(this.d.client, { type: 'caption', role: 'user', text });
    if (!isEmergencyMessage(text)) return true;
    sendJson(this.d.client, { type: 'emergency', ...emergencyResponse(this.d.context.regionCode) });
    this.finish('emergency');
    return false;
  }

  /** Returns false when the model's running answer broke the safety policy and the session was ended. */
  private onModelSpeech(raw: string): boolean {
    this.turnText += String(raw);
    if (checkFreeText(this.turnText, this.d.context.aq.snapshot).length > 0) {
      sendJson(this.d.client, { type: 'blocked', message: BLOCKED_MESSAGE });
      void audit(this.d.ctx, this.d.req, { userId: this.d.userId, type: 'live.blocked' });
      this.finish('safety_blocked', false);
      return false;
    }
    sendJson(this.d.client, { type: 'caption', role: 'assistant', text: caption(raw) });
    return true;
  }

  private endTurn(type: 'interrupted' | 'turn_complete'): void {
    this.turnText = '';
    sendJson(this.d.client, { type });
  }

  private overRateLimit(now: number): boolean {
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.msgCount = 0;
    }
    return ++this.msgCount > MAX_CLIENT_MSGS_PER_SEC;
  }

  private onClient(raw: WebSocket.RawData, isBinary: boolean): void {
    if (this.closed) return;
    if (isBinary) return this.finish('protocol_error');
    const now = Date.now();
    if (this.overRateLimit(now)) return this.finish('rate_limited');
    let msg: ClientMsg;
    try {
      msg = clientMsgSchema.parse(JSON.parse(raw.toString()));
    } catch {
      return this.finish('protocol_error');
    }
    if (msg.type === 'stop') return this.finish('stopped_by_user');
    if (this.d.upstream.readyState !== WebSocket.OPEN) return;
    this.lastClientAudio = now;
    this.d.upstream.send(upstreamInput(msg));
  }
}
