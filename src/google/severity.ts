import type { AirQualityIndex, AirQualitySnapshot } from './types.js';

export type Severity = 'good' | 'moderate' | 'sensitive' | 'unhealthy' | 'very_unhealthy' | 'unknown';

/**
 * Google's Universal AQI (uaqi) is higher = better; most local indexes (usa_epa, ind_cpcb, ...) are higher = worse.
 * We map the *provider category* wherever possible and only fall back to numeric bands for the two well-known scales.
 */
export function severityOf(index: AirQualityIndex): Severity {
  if (index.code === 'uaqi') {
    const v = index.aqi;
    if (v >= 80) return 'good';
    if (v >= 60) return 'good';
    if (v >= 40) return 'moderate';
    if (v >= 20) return 'unhealthy';
    return 'very_unhealthy';
  }
  const v = index.aqi;
  if (index.code === 'usa_epa' || index.code === 'usa_epa_nowcast') {
    if (v <= 50) return 'good';
    if (v <= 100) return 'moderate';
    if (v <= 150) return 'sensitive';
    if (v <= 200) return 'unhealthy';
    return 'very_unhealthy';
  }
  if (index.code === 'ind_cpcb') {
    if (v <= 50) return 'good';
    if (v <= 100) return 'good';
    if (v <= 200) return 'moderate';
    if (v <= 300) return 'unhealthy';
    return 'very_unhealthy';
  }
  return 'unknown';
}

/** Index shown first: the regional index when present (more meaningful locally), else the universal AQI. */
export function primaryIndex(s: AirQualitySnapshot): AirQualityIndex | undefined {
  return s.indexes.find((i) => i.code !== 'uaqi') ?? s.indexes[0];
}

export function overallSeverity(s: AirQualitySnapshot): Severity {
  const p = primaryIndex(s);
  return p ? severityOf(p) : 'unknown';
}
