import { $, show } from './dom.js';
import { api, ApiError } from './api.js';

const VIEWS = ['today', 'ask', 'household', 'routines', 'indoor', 'community'];

// ---- Menu / routing ---------------------------------------------------------------------------
export function currentView() {
  const v = location.hash.replace(/^#\/?/, '').split('?')[0];
  return VIEWS.includes(v) ? v : 'today';
}

export function go(view) {
  if (location.hash !== `#/${view}`) location.hash = `#/${view}`;
  else render(true);
}

function render(focus) {
  const view = currentView();
  for (const v of VIEWS) show($(`view-${v}`), v === view);
  for (const a of document.querySelectorAll('[data-view]')) {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const sec = $(`view-${view}`);
  document.title = `${sec.dataset.title} · ClearAir Together`;
  if (focus) {
    window.scrollTo({ top: 0 });
    const t = sec.querySelector('h1');
    t?.focus({ preventScroll: true });
  }
}

// ---- Account ----------------------------------------------------------------------------------
let me = { kind: 'none' };
let mode = 'signin';
let hooks = {};
let opener = null;

const isIn = () => me.kind === 'registered';
const initial = () => (me.displayName || me.email || '?').trim().charAt(0).toUpperCase();

function paintAccount() {
  $('avatar').textContent = isIn() ? initial() : '?';
  $('account-label').textContent = isIn() ? me.displayName || 'Account' : 'Sign in';
  $('account-btn').setAttribute('aria-label', isIn() ? `Account menu for ${me.displayName || me.email}` : 'Account menu: sign in or create an account');
  $('account-who').textContent = isIn() ? `Signed in as ${me.email}` : 'Not signed in. Your data stays on this device.';
  show($('account-who'));
  show($('menu-signin'), !isIn());
  show($('menu-register'), !isIn());
  show($('menu-signout'), isIn());
}

function setMenu(open) {
  show($('account-menu'), open);
  $('account-btn').setAttribute('aria-expanded', String(open));
  if (open) $('account-menu').querySelector('button:not([hidden])')?.focus();
}

function setMode(m) {
  mode = m;
  const reg = m === 'register';
  $('auth-title').textContent = reg ? 'Create your account' : 'Welcome back';
  $('auth-submit').textContent = reg ? 'Create account' : 'Sign in';
  $('tab-signin').setAttribute('aria-selected', String(!reg));
  $('tab-register').setAttribute('aria-selected', String(reg));
  show($('name-field'), reg);
  show($('pass-hint'), reg);
  $('auth-pass').autocomplete = reg ? 'new-password' : 'current-password';
  $('auth-hint').textContent = reg
    ? 'Create an account to keep your home and plans across devices. What you’ve already saved comes with you.'
    : 'Sign in to pick up your home and plans on this device.';
  show($('auth-error'), false);
}

function openAuth(m) {
  setMenu(false);
  opener = document.activeElement;
  setMode(m);
  $('auth-pass').value = '';
  const d = $('auth-dialog');
  if (typeof d.showModal === 'function') d.showModal();
  else d.setAttribute('open', '');
  $('auth-email').focus();
}

function closeAuth() {
  const d = $('auth-dialog');
  if (typeof d.close === 'function') d.close();
  else d.removeAttribute('open');
  $('auth-pass').value = '';
  opener?.focus?.();
}

async function submitAuth(ev) {
  ev.preventDefault();
  const err = $('auth-error');
  show(err, false);
  const email = $('auth-email').value.trim();
  const password = $('auth-pass').value;
  if (!email || !password) {
    err.textContent = 'Enter your email and password.';
    show(err);
    return;
  }
  const body = { email, password };
  if (mode === 'register') {
    if (password.length < 10) {
      err.textContent = 'Use at least 10 characters for your password.';
      show(err);
      return;
    }
    const name = $('auth-name').value.trim();
    if (name) body.displayName = name;
  }
  $('auth-submit').disabled = true;
  try {
    await api('POST', `/api/v1/auth/${mode === 'register' ? 'register' : 'login'}`, body);
    const was = me;
    me = await api('GET', '/api/v1/auth/me');
    paintAccount();
    closeAuth();
    hooks.onAccount?.(me, mode === 'register' ? 'register' : 'login', was);
  } catch (e) {
    err.textContent =
      e instanceof ApiError && e.code === 'validation_error'
        ? 'Check your email address and use at least 10 characters for the password.'
        : e instanceof ApiError
          ? e.message
          : 'Something went wrong. Please try again.';
    show(err);
  } finally {
    $('auth-submit').disabled = false;
  }
}

async function signOut() {
  setMenu(false);
  try {
    await api('POST', '/api/v1/auth/logout');
  } catch {
    /* cookie may already be gone */
  }
  me = { kind: 'none' };
  paintAccount();
  hooks.onAccount?.(me, 'logout');
}

export const account = () => me;

export async function initNav(h = {}) {
  hooks = h;
  window.addEventListener('hashchange', () => render(true));
  render(false);

  $('account-btn').addEventListener('click', () => setMenu($('account-menu').hidden));
  $('menu-signin').addEventListener('click', () => openAuth('signin'));
  $('menu-register').addEventListener('click', () => openAuth('register'));
  $('menu-signout').addEventListener('click', () => void signOut());
  document.addEventListener('click', (e) => {
    if (!$('account').contains(e.target)) setMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('account-menu').hidden) {
      setMenu(false);
      $('account-btn').focus();
    }
  });
  $('tab-signin').addEventListener('click', () => setMode('signin'));
  $('tab-register').addEventListener('click', () => setMode('register'));
  $('auth-close').addEventListener('click', closeAuth);
  $('auth-form').addEventListener('submit', submitAuth);
  $('auth-dialog').addEventListener('cancel', () => {
    $('auth-pass').value = '';
  });

  paintAccount();
  try {
    me = await api('GET', '/api/v1/auth/me');
  } catch {
    me = { kind: 'none' };
  }
  paintAccount();
  hooks.onAccount?.(me, 'init');
}
