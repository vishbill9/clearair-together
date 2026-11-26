import { and, desc, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { airQualitySnapshots } from '../db/schema.js';
import { GoogleAirQualityClient, UpstreamError } from './client.js';
import { locationKey } from './request.js';
import type { AirQualityForecast, AirQualitySnapshot, Freshness } from './types.js';

export interface AirQualityResult {
  /** `null` when no real data can be shown. The UI must render the status instead of any number. */
  snapshot: AirQualitySnapshot | null;
  status: Freshness;
  /** Safe, user-facing explanation when status is not `fresh`. */
  reason?: string;
  upstreamError?: UpstreamError['kind'];
}

export interface ServiceOptions {
  client: GoogleAirQualityClient | null;
  db: Db | null;
  cacheTtlSeconds: number;
  staleMaxSeconds: number;
  now?: () => Date;
}

const NOT_CONFIGURED_REASON =
  'Air-quality data is not configured on this server (Google Air Quality API key missing). No air-quality values are shown.';

export class AirQualityService {
  private readonly now: () => Date;
  constructor(private readonly o: ServiceOptions) {
    this.now = o.now ?? (() => new Date());
  }

  get configured(): boolean {
    return this.o.client !== null;
  }

  async getCurrent(q: { lat: number; lng: number; languageCode: string }): Promise<AirQualityResult> {
    const key = locationKey(q.lat, q.lng, q.languageCode);
    const cached = await this.readCache(key);
    const nowMs = this.now().getTime();

    if (cached) {
      const age = (nowMs - Date.parse(cached.fetchedAt)) / 1000;
      if (age <= this.o.cacheTtlSeconds) {
        return { snapshot: { ...cached, freshness: 'cached' }, status: 'cached' };
      }
    }

    if (!this.o.client) {
      return { snapshot: null, status: 'not_configured', reason: NOT_CONFIGURED_REASON };
    }

    try {
      const snap = await this.o.client.fetchCurrent(q);
      await this.writeCache(key, snap);
      return { snapshot: snap, status: 'fresh' };
    } catch (e) {
      if (!(e instanceof UpstreamError)) throw e;
      if (cached) {
        const age = (nowMs - Date.parse(cached.fetchedAt)) / 1000;
        if (age <= this.o.staleMaxSeconds) {
          return {
            snapshot: { ...cached, freshness: 'stale' },
            status: 'stale',
            reason: `The air-quality provider is unreachable, so this is the last real reading from ${cached.fetchedAt}. It may be out of date.`,
            upstreamError: e.kind,
          };
        }
      }
      return {
        snapshot: null,
        status: 'unavailable',
        reason: 'Air-quality data is temporarily unavailable. No values are shown rather than guessing.',
        upstreamError: e.kind,
      };
    }
  }

  async getForecast(
    q: { lat: number; lng: number; languageCode: string },
    startIso: string,
    endIso: string,
  ): Promise<{
    forecast: AirQualityForecast | null;
    status: Freshness;
    reason?: string;
    upstreamError?: UpstreamError['kind'];
  }> {
    if (!this.o.client) return { forecast: null, status: 'not_configured', reason: NOT_CONFIGURED_REASON };
    try {
      const forecast = await this.o.client.fetchForecast(q, startIso, endIso);
      return { forecast, status: 'fresh' };
    } catch (e) {
      if (!(e instanceof UpstreamError)) throw e;
      return {
        forecast: null,
        status: 'unavailable',
        reason: 'The air-quality forecast is temporarily unavailable.',
        upstreamError: e.kind,
      };
    }
  }

  private async readCache(key: string): Promise<AirQualitySnapshot | null> {
    if (!this.o.db) return null;
    const cutoff = new Date(this.now().getTime() - this.o.staleMaxSeconds * 1000);
    const rows = await this.o.db
      .select()
      .from(airQualitySnapshots)
      .where(and(eq(airQualitySnapshots.locationKey, key), gt(airQualitySnapshots.fetchedAt, cutoff)))
      .orderBy(desc(airQualitySnapshots.fetchedAt))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const payload = row.payload as AirQualitySnapshot;
    if (payload?.source !== 'google_air_quality') return null;
    return payload;
  }

  private async writeCache(key: string, snap: AirQualitySnapshot): Promise<void> {
    if (!this.o.db) return;
    try {
      await this.o.db.insert(airQualitySnapshots).values({
        locationKey: key,
        latitude: snap.location.latitude,
        longitude: snap.location.longitude,
        source: 'google_air_quality',
        observedAt: new Date(snap.observedAt),
        fetchedAt: new Date(snap.fetchedAt),
        regionCode: snap.regionCode ?? null,
        payload: snap,
      });
    } catch {
      // Cache write failure must never hide a real reading from the user.
    }
  }
}
