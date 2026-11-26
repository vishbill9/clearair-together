/**
 * Approved, static general guidance. This is education, not a measurement and not personal medical advice.
 * The assistant may only cite ids from this list. Anything else is rejected by the safety policy.
 */
export interface GuidanceItem {
  id: string;
  title: string;
  /** Only real, stable public pages. Items without a URL are cited by title only. */
  url?: string;
  text: string;
  label: 'general guidance';
}

export const APPROVED_GUIDANCE: readonly GuidanceItem[] = [
  {
    id: 'epa-aqi-basics',
    title: 'US EPA AirNow: AQI basics',
    url: 'https://www.airnow.gov/aqi/aqi-basics/',
    text: 'Higher values on most local AQI scales mean greater health concern. People with heart or lung conditions, older adults, children and pregnant people are generally advised to take more care when air quality is poor.',
    label: 'general guidance',
  },
  {
    id: 'who-air-pollution',
    title: 'WHO: Air pollution',
    url: 'https://www.who.int/health-topics/air-pollution',
    text: 'Fine particles (PM2.5) can penetrate deep into the lungs. Reducing exposure and reducing emissions are both useful, and they are different things.',
    label: 'general guidance',
  },
  {
    id: 'g-timing',
    title: 'General guidance: timing outdoor activity',
    text: 'When air quality is poor, shifting strenuous outdoor activity to a time when readings are lower, or doing it indoors, usually reduces how much polluted air is breathed in.',
    label: 'general guidance',
  },
  {
    id: 'g-filtration',
    title: 'General guidance: indoor air cleaning',
    text: "A HEPA-type purifier sized for the room, or a well-fitted HVAC filter, can reduce indoor fine particles. Effectiveness depends on room size, the purifier's clean air delivery rate (CADR) and how long it runs. Avoid devices that deliberately produce ozone.",
    label: 'general guidance',
  },
  {
    id: 'g-source-control',
    title: 'General guidance: reducing indoor sources',
    text: 'Cooking can raise indoor particle levels. Using a range hood or exhaust fan vented outdoors, and avoiding burning candles, incense or smoking indoors, helps keep indoor levels lower.',
    label: 'general guidance',
  },
  {
    id: 'g-masks',
    title: 'General guidance: respirators',
    text: 'A well-fitted respirator (such as N95, FFP2 or KN95) can reduce inhaled particles when worn correctly. Loose cloth or surgical masks give little protection from fine particles.',
    label: 'general guidance',
  },
  {
    id: 'g-commute',
    title: 'General guidance: commuting choices',
    text: "Lower-emission travel (walking, cycling, public transit) reduces emissions. Personal exposure while travelling depends on the route, traffic and the day's air quality, so the two can differ.",
    label: 'general guidance',
  },
];

export const APPROVED_SOURCE_IDS = new Set(APPROVED_GUIDANCE.map((g) => g.id));
export const APPROVED_URLS = new Set(APPROVED_GUIDANCE.flatMap((g) => (g.url ? [g.url] : [])));

export const sourceInfo = (id: string) => APPROVED_GUIDANCE.find((g) => g.id === id);
