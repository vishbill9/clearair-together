export const currentBody = (over: Record<string, unknown> = {}) => ({
  dateTime: '2026-11-26T08:00:00Z',
  regionCode: 'in',
  indexes: [
    {
      code: 'uaqi',
      displayName: 'Universal AQI',
      aqi: 42,
      category: 'Moderate air quality',
      dominantPollutant: 'pm25',
    },
    {
      code: 'ind_cpcb',
      displayName: 'AQI (CPCB)',
      aqi: 188,
      category: 'Moderate',
      dominantPollutant: 'pm25',
    },
  ],
  pollutants: [
    {
      code: 'pm25',
      displayName: 'PM2.5',
      concentration: { value: 71.2, units: 'MICROGRAMS_PER_CUBIC_METER' },
    },
    { code: 'o3', displayName: 'O3', concentration: { value: 12, units: 'PARTS_PER_BILLION' } },
  ],
  healthRecommendations: {
    generalPopulation: 'Reduce prolonged outdoor exertion.',
    elderly: 'Stay indoors if possible.',
  },
  ...over,
});

export const forecastHour = (iso: string, aqi = 50) => ({
  dateTime: iso,
  indexes: [{ code: 'uaqi', displayName: 'Universal AQI', aqi, category: 'Moderate' }],
});

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
