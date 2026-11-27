import { $, clear, h, show } from './dom.js';
import { api } from './api.js';
import { errText, fmt, setMsg, state, STATUS_TEXT, syncButtons } from './state.js';

/** Needle position (0-100) for each verified category; unknown points straight up. */
const SEVERITY_POS = { good: 10, moderate: 30, sensitive: 50, unhealthy: 70, very_unhealthy: 90 };
const STALE_NOTE = ' The provider could not be reached, so this reading is older than usual.';
const NO_DATA_NOTE = 'We only show real readings, so there is nothing to display for this place right now.';

const primary = (s) => s.indexes.find((i) => i.code !== 'uaqi') ?? s.indexes[0];
const label = (k) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

function headlineFor(d, p) {
  if (p) return p.category;
  return d.status === 'not_configured' ? 'Air-quality data is not configured' : 'No reading available';
}

function renderGauge(d, s, p) {
  const col = $('column');
  const real = Boolean(s) && d.severity !== 'unknown';
  col.classList.toggle('none', !real);
  col.dataset.active = real ? d.severity : '';
  $('column-marker').style.transform = `rotate(${(SEVERITY_POS[d.severity] ?? 50) * 1.8 - 90}deg)`;
  col.setAttribute(
    'aria-label',
    s ? `Air quality category: ${p?.category ?? 'unknown'}` : 'No air-quality reading available',
  );
  document.body.dataset.sky = real ? d.severity : 'none';
}

function renderHero(d, s, p) {
  $('hero-kicker').textContent = `Air quality now · ${STATUS_TEXT[d.status] ?? d.status}`;
  $('hero-title').textContent = headlineFor(d, p);
  $('hero-sub').textContent = p
    ? `${p.displayName}: ${p.aqi}. Observed ${fmt(s.observedAt)}.${d.status === 'stale' ? STALE_NOTE : ''}`
    : d.reason || NO_DATA_NOTE;
  show($('hero-actions'));
}

function renderBadges(d, s) {
  const fb = $('fresh-badge');
  fb.textContent = STATUS_TEXT[d.status] ?? d.status;
  fb.dataset.s = d.status;
  $('source-badge').textContent = s ? 'Source: Google Air Quality API' : 'No data source reached';
}

function renderProvenance(s) {
  const prov = $('prov');
  clear(prov);
  if (!s) return;
  const rows = [
    ['Observed', `${fmt(s.observedAt)} (${s.observedAt})`],
    ['Fetched', `${fmt(s.fetchedAt)} (${s.fetchedAt})`],
    ['Region', s.regionCode ?? 'Not provided'],
    ['Source', s.source],
  ];
  for (const [k, v] of rows) prov.append(h('dt', {}, k), h('dd', {}, v));
}

function renderIndexes(s, p) {
  const idx = $('indexes');
  clear(idx);
  const note = (i) => (i.code === 'uaqi' ? '. On this scale a higher number is better.' : '');
  for (const i of s?.indexes ?? [])
    idx.append(h('li', {}, `${i.displayName}: ${i.aqi} (${i.category})${note(i)}`));
  if (!s) idx.append(h('li', {}, 'No index values to show.'));
  const dom = p?.dominantPollutant;
  $('dominant').textContent = dom ? `Dominant pollutant: ${dom.toUpperCase()}` : '';
}

function renderPollutants(s) {
  const tb = $('pollutants').tBodies[0];
  clear(tb);
  const rows = s?.pollutants ?? [];
  for (const x of rows) {
    tb.append(h('tr', {}, h('th', { scope: 'row' }, x.displayName), h('td', {}, `${x.value} ${x.units}`)));
  }
  if (!rows.length) tb.append(h('tr', {}, h('td', { colspan: '2' }, 'No pollutant data.')));
}

function renderHealthNotes(s) {
  const ph = $('provider-health');
  clear(ph);
  const notes = Object.entries(s?.healthRecommendations ?? {});
  for (const [k, v] of notes) ph.append(h('li', {}, h('strong', {}, `${label(k)}: `), v));
  if (!notes.length) ph.append(h('li', {}, 'The provider did not include health notes.'));
}

/** Renders a reading. With no snapshot, every part shows its honest empty state and no numbers. */
export function renderStatus(d) {
  state.aq = d;
  show($('status-empty'), false);
  show($('status'));
  const s = d.snapshot;
  const p = s && primary(s);
  $('status-headline').textContent = headlineFor(d, p);
  setMsg($('status-reason'), d.reason);
  renderGauge(d, s, p);
  renderHero(d, s, p);
  renderBadges(d, s);
  renderProvenance(s);
  renderIndexes(s, p);
  renderPollutants(s);
  renderHealthNotes(s);
  syncButtons();
}

function readLocation() {
  const raw = [$('lat').value.trim(), $('lng').value.trim()];
  if (raw.some((v) => v === '')) return null;
  const [lat, lng] = raw.map(Number);
  const valid = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return valid ? { lat, lng } : null;
}

function locationError(text) {
  $('loc-error').textContent = text;
  show($('loc-error'), Boolean(text));
}

/** Validates the form, then fetches the verified reading for that place. */
export async function checkAir() {
  const loc = readLocation();
  if (!loc) return locationError('Enter a latitude between -90 and 90 and a longitude between -180 and 180.');
  locationError('');
  state.loc = loc;
  const panel = $('status-panel');
  panel.setAttribute('aria-busy', 'true');
  try {
    const q = `lat=${encodeURIComponent(loc.lat)}&lng=${encodeURIComponent(loc.lng)}`;
    renderStatus(await api('GET', `/api/v1/air-quality?${q}`));
  } catch (e) {
    locationError(errText(e));
  } finally {
    panel.removeAttribute('aria-busy');
  }
}

function useMyLocation() {
  if (!navigator.geolocation)
    return locationError('Your browser cannot share location. Enter coordinates instead.');
  navigator.geolocation.getCurrentPosition(
    (p) => {
      $('lat').value = p.coords.latitude.toFixed(2);
      $('lng').value = p.coords.longitude.toFixed(2);
      void checkAir();
    },
    () => locationError('Location was not shared. Enter coordinates instead.'),
    { maximumAge: 600000, timeout: 10000 },
  );
}

export function initStatus() {
  $('loc-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void checkAir();
  });
  $('geo').addEventListener('click', useMyLocation);
}
