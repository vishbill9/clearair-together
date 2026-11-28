import type { AirQualityIndex, AirQualitySnapshot } from './types.js';

export type Severity = 'good' | 'moderate' | 'sensitive' | 'unhealthy' | 'very_unhealthy' | 'unknown';

interface Scale {
  /** Google's Universal AQI is higher = better; most local indexes are higher = worse. */
  higherIsBetter: boolean;
  /** Ordered limits: the first band the value falls within wins. Past the last band: very unhealthy. */
  bands: Array<[limit: number, severity: Severity]>;
}

const UAQI: Scale = {
  higherIsBetter: true,
  bands: [
    [60, 'good'],
    [40, 'moderate'],
    [20, 'unhealthy'],
  ],
};
const US_EPA: Scale = {
  higherIsBetter: false,
  bands: [
    [50, 'good'],
    [100, 'moderate'],
    [150, 'sensitive'],
    [200, 'unhealthy'],
  ],
};
const IND_CPCB: Scale = {
  higherIsBetter: false,
  bands: [
    [100, 'good'],
    [200, 'moderate'],
    [300, 'unhealthy'],
  ],
};

const SCALES: Record<string, Scale> = {
  uaqi: UAQI,
  usa_epa: US_EPA,
  usa_epa_nowcast: US_EPA,
  ind_cpcb: IND_CPCB,
};

/** Maps an index value to a severity for the scales we know; any other index is `unknown`. */
export function severityOf(index: AirQualityIndex): Severity {
  const scale = SCALES[index.code];
  if (!scale) return 'unknown';
  const within = ([limit]: [number, Severity]) =>
    scale.higherIsBetter ? index.aqi >= limit : index.aqi <= limit;
  return scale.bands.find(within)?.[1] ?? 'very_unhealthy';
}

/** Index shown first: the regional index when present (more meaningful locally), else the universal AQI. */
export function primaryIndex(s: AirQualitySnapshot): AirQualityIndex | undefined {
  return s.indexes.find((i) => i.code !== 'uaqi') ?? s.indexes[0];
}

/** Severity of the snapshot's primary index (regional when present), or `unknown`. */
export function overallSeverity(s: AirQualitySnapshot): Severity {
  const p = primaryIndex(s);
  return p ? severityOf(p) : 'unknown';
}
