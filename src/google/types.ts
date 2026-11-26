export type Freshness = 'fresh' | 'cached' | 'stale' | 'unavailable' | 'not_configured';

export interface AirQualityIndex {
  code: string;
  displayName: string;
  aqi: number;
  category: string;
  dominantPollutant?: string;
}

export interface Pollutant {
  code: string;
  displayName: string;
  value: number;
  units: string;
}

/** Internal normalized shape. Always derived from a real Google Air Quality API response. */
export interface AirQualitySnapshot {
  source: 'google_air_quality';
  location: { latitude: number; longitude: number; approximateLabel?: string };
  observedAt: string;
  fetchedAt: string;
  regionCode?: string;
  indexes: AirQualityIndex[];
  pollutants: Pollutant[];
  healthRecommendations?: Record<string, string>;
  freshness: Freshness;
}

export interface ForecastHour {
  forecastAt: string;
  indexes: AirQualityIndex[];
  pollutants: Pollutant[];
  healthRecommendations?: Record<string, string>;
}

export interface AirQualityForecast {
  source: 'google_air_quality';
  location: { latitude: number; longitude: number; approximateLabel?: string };
  fetchedAt: string;
  regionCode?: string;
  hours: ForecastHour[];
  freshness: Freshness;
}
