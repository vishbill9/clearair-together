import type { Config } from '../config.js';
import {
  buildCurrentRequest,
  buildForecastRequest,
  isValidPageToken,
  type CurrentConditionsRequest,
} from './request.js';
import {
  MalformedResponseError,
  forecastResponseSchema,
  normalizeCurrent,
  normalizeForecastHour,
} from './normalize.js';
import type { AirQualityForecast, AirQualitySnapshot, ForecastHour } from './types.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GoogleClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  maxResponseBytes: number;
  maxPages: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export type UpstreamKind =
  'auth' | 'rate_limited' | 'server' | 'timeout' | 'network' | 'malformed' | 'too_large' | 'bad_request';

export class UpstreamError extends Error {
  constructor(
    public readonly kind: UpstreamKind,
    public readonly upstreamStatus?: number,
  ) {
    super(`Google Air Quality upstream error: ${kind}${upstreamStatus ? ` (${upstreamStatus})` : ''}`);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GoogleAirQualityClient {
  private readonly o: Required<Omit<GoogleClientOptions, 'fetchImpl'>> & { fetchImpl: FetchLike };

  constructor(opts: GoogleClientOptions) {
    this.o = {
      ...opts,
      fetchImpl: opts.fetchImpl ?? ((u, i) => fetch(u, i)),
      sleep: opts.sleep ?? defaultSleep,
      now: opts.now ?? (() => new Date()),
    };
  }

  static fromConfig(cfg: Config, extra: Partial<GoogleClientOptions> = {}): GoogleAirQualityClient | null {
    if (!cfg.google.apiKey) return null;
    return new GoogleAirQualityClient({
      apiKey: cfg.google.apiKey,
      baseUrl: cfg.google.baseUrl,
      timeoutMs: 8000,
      maxRetries: 2,
      maxResponseBytes: 2_000_000,
      maxPages: 5,
      ...extra,
    });
  }

  private endpoint(path: 'currentConditions:lookup' | 'forecast:lookup'): string {
    return `${this.o.baseUrl.replace(/\/$/, '')}/v1/${path}`;
  }

  private async post(
    path: 'currentConditions:lookup' | 'forecast:lookup',
    body: CurrentConditionsRequest,
  ): Promise<unknown> {
    const url = `${this.endpoint(path)}?key=${encodeURIComponent(this.o.apiKey)}`;
    let lastErr: UpstreamError | undefined;
    for (let attempt = 0; attempt <= this.o.maxRetries; attempt++) {
      try {
        return await this.once(url, body);
      } catch (e) {
        if (!(e instanceof UpstreamError)) throw e;
        lastErr = e;
        const retryable =
          e.kind === 'server' || e.kind === 'timeout' || e.kind === 'network' || e.kind === 'rate_limited';
        if (!retryable || attempt === this.o.maxRetries) break;
        await this.o.sleep(Math.min(2000, 200 * 2 ** attempt));
      }
    }
    throw lastErr ?? new UpstreamError('network');
  }

  private async once(url: string, body: unknown): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs);
    let res: Response;
    try {
      res = await this.o.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
        redirect: 'error',
      });
    } catch (e) {
      clearTimeout(timer);
      if ((e as Error)?.name === 'AbortError') throw new UpstreamError('timeout');
      throw new UpstreamError('network');
    }
    try {
      if (res.status === 401 || res.status === 403) throw new UpstreamError('auth', res.status);
      if (res.status === 429) throw new UpstreamError('rate_limited', 429);
      if (res.status >= 500) throw new UpstreamError('server', res.status);
      if (res.status >= 400) throw new UpstreamError('bad_request', res.status);
      const text = await this.readLimited(res);
      try {
        return JSON.parse(text);
      } catch {
        throw new UpstreamError('malformed', res.status);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async readLimited(res: Response): Promise<string> {
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > this.o.maxResponseBytes) throw new UpstreamError('too_large');
    if (!res.body) {
      const t = await res.text();
      if (Buffer.byteLength(t) > this.o.maxResponseBytes) throw new UpstreamError('too_large');
      return t;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.o.maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpstreamError('too_large');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async fetchCurrent(q: { lat: number; lng: number; languageCode: string }): Promise<AirQualitySnapshot> {
    const body = buildCurrentRequest(q);
    const json = await this.post('currentConditions:lookup', body);
    try {
      return normalizeCurrent(json, {
        latitude: body.location.latitude,
        longitude: body.location.longitude,
        fetchedAt: this.o.now(),
      });
    } catch (e) {
      if (e instanceof MalformedResponseError) throw new UpstreamError('malformed');
      throw e;
    }
  }

  async fetchForecast(
    q: { lat: number; lng: number; languageCode: string },
    startIso: string,
    endIso: string,
  ): Promise<AirQualityForecast> {
    const byTime = new Map<string, ForecastHour>();
    let token: string | undefined;
    let regionCode: string | undefined;
    const seenTokens = new Set<string>();
    for (let page = 0; page < this.o.maxPages; page++) {
      const body = buildForecastRequest(q, startIso, endIso, token);
      const json = await this.post('forecast:lookup', body);
      const parsed = forecastResponseSchema.safeParse(json);
      if (!parsed.success) throw new UpstreamError('malformed');
      regionCode ??= parsed.data.regionCode;
      try {
        for (const raw of parsed.data.hourlyForecasts ?? []) {
          const hour = normalizeForecastHour(raw);
          if (hour && !byTime.has(hour.forecastAt)) byTime.set(hour.forecastAt, hour);
        }
      } catch (e) {
        if (e instanceof MalformedResponseError) throw new UpstreamError('malformed');
        throw e;
      }
      const next = parsed.data.nextPageToken;
      if (!next) break;
      if (!isValidPageToken(next) || seenTokens.has(next)) throw new UpstreamError('malformed');
      seenTokens.add(next);
      token = next;
    }
    const hours = [...byTime.values()].sort((a, b) => a.forecastAt.localeCompare(b.forecastAt));
    const out: AirQualityForecast = {
      source: 'google_air_quality',
      location: { latitude: q.lat, longitude: q.lng },
      fetchedAt: this.o.now().toISOString(),
      hours,
      freshness: 'fresh',
    };
    if (regionCode) out.regionCode = regionCode.toUpperCase();
    return out;
  }
}
