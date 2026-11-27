const isEmpty = (v) => v === false || v === null || v === undefined;

function setAttr(el, k, v) {
  if (k === 'class') el.className = v;
  else if (k === 'dataset') Object.assign(el.dataset, v);
  else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
  else el.setAttribute(k, v === true ? '' : String(v));
}

/** Safe DOM builder: text is always set via textContent, never parsed as HTML. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (!isEmpty(v)) setAttr(el, k, v);
  for (const c of children.flat(Infinity)) {
    if (!isEmpty(c)) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
/**
 * Element by id. Typed loosely because form controls of several kinds are looked up by id.
 * @param {string} id
 * @returns {any}
 */
export const $ = (id) => document.getElementById(id);
/**
 * All elements matching a selector, as an array.
 * @param {string} selector
 * @returns {HTMLElement[]}
 */
export const $$ = (selector) =>
  [...document.querySelectorAll(selector)].map((el) => /** @type {HTMLElement} */ (el));

export const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
};
export const show = (el, on = true) => {
  el.hidden = !on;
};
