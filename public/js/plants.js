import { $, $$, clear, h, show } from './dom.js';
import { api, ApiError } from './api.js';

const LIGHT_TEXT = { low: 'Low light', medium: 'Medium light', bright: 'Bright light' };
const CARE_TEXT = { very_easy: 'Very easy', easy: 'Easy', moderate: 'Some attention' };

let plants = [];

const matches = (p, light, pets) => (!light || p.light.includes(light)) && (!pets || p.petSafe);

function card(p) {
  return h(
    'li',
    { class: 'plant' },
    h('img', {
      src: `/plants/${p.id}.svg`,
      alt: `Illustration of a ${p.name} in a pot`,
      width: '200',
      height: '200',
      loading: 'lazy',
    }),
    h(
      'div',
      { class: 'plant-body' },
      h('h3', {}, p.name),
      h('p', { class: 'latin' }, p.botanical),
      h(
        'p',
        { class: 'tags' },
        h('span', { class: 'tag' }, p.light.map((l) => LIGHT_TEXT[l]).join(' · ')),
        h('span', { class: 'tag' }, CARE_TEXT[p.care]),
        h('span', { class: `tag ${p.petSafe ? 'safe' : 'warn'}` }, p.petSafe ? 'Pet-safe' : 'Toxic to pets'),
      ),
      h('p', {}, p.why),
      h('p', { class: 'hint' }, `Water: ${p.water}`),
      h('p', { class: 'hint' }, p.petNote),
    ),
  );
}

function render() {
  const light = $('plant-light').value;
  const pets = $('plant-pets').checked;
  const list = plants.filter((p) => matches(p, light, pets));
  const grid = $('plant-grid');
  clear(grid);
  list.forEach((p) => grid.append(card(p)));
  $('plant-count').textContent = list.length
    ? `${list.length} ${list.length === 1 ? 'plant suits' : 'plants suit'} this room.`
    : 'No plants match both filters. Try a different light level.';
}

function addMsg(kind, ...nodes) {
  const box = $('plantchat');
  const m = h('div', { class: `msg ${kind}` }, nodes);
  box.append(m);
  box.scrollTop = box.scrollHeight;
  return m;
}

async function ask(text) {
  const q = text.trim();
  if (q.length < 2) return;
  const btn = $('plantchat-send');
  btn.disabled = true;
  addMsg('user', h('p', {}, q));
  const wait = addMsg('bot', h('p', { class: 'hint' }, 'Thinking…'));
  try {
    const body = { question: q };
    if ($('plant-light').value) body.light = $('plant-light').value;
    if ($('plant-pets').checked) body.pets = true;
    const d = await api('POST', '/api/v1/plants/chat', body);
    wait.remove();
    const nodes = [];
    if (d.kind === 'urgent') nodes.push(h('h4', {}, 'This may be urgent'));
    if (d.kind === 'safety')
      nodes.push(
        h(
          'p',
          { class: 'notice' },
          'The generated answer did not pass safety checks, so this general reply is shown.',
        ),
      );
    nodes.push(h('p', {}, d.answer));
    if (d.cautions.length)
      nodes.push(
        h(
          'ul',
          {},
          d.cautions.map((c) => h('li', {}, c)),
        ),
      );
    addMsg(d.kind === 'urgent' ? 'bot emergency' : 'bot', ...nodes);
    $('plantchat-input').value = '';
  } catch (e) {
    wait.remove();
    addMsg(
      'bot',
      h(
        'p',
        { class: 'error' },
        e instanceof ApiError ? e.message : 'Something went wrong. Please try again.',
      ),
    );
  } finally {
    btn.disabled = false;
  }
}

export async function initPlants({ chatOn }) {
  show($('plantchat-on'), chatOn);
  show($('plantchat-off'), !chatOn);
  $('plant-light').addEventListener('change', render);
  $('plant-pets').addEventListener('change', render);
  $('plantchat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void ask($('plantchat-input').value);
  });
  for (const c of $$('.chip[data-pq]')) c.addEventListener('click', () => void ask(c.dataset.pq));
  try {
    plants = (await api('GET', '/api/v1/plants')).plants;
    render();
  } catch {
    $('plant-count').textContent = 'The plant list could not be loaded. Please refresh.';
  }
}
