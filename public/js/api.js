function cookie(name) {
  const m = document.cookie.split('; ').find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}

export class ApiError extends Error {
  constructor(status, error) {
    super(error?.message || 'Request failed.');
    this.status = status;
    this.code = error?.code || 'unknown';
    this.details = error?.details;
  }
}

async function ensureCsrf() {
  if (!cookie('ca_csrf')) await fetch('/api/v1/session', { credentials: 'same-origin' });
}

export async function api(method, path, body) {
  const headers = { accept: 'application/json' };
  if (method !== 'GET') {
    await ensureCsrf();
    headers['x-csrf-token'] = cookie('ca_csrf');
  }
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, {
      code: 'network',
      message: 'Could not reach the server. Check your connection and try again.',
    });
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON error */
  }
  if (!res.ok || !json || json.error) throw new ApiError(res.status, json?.error);
  return json.data;
}

export const csrfToken = () => cookie('ca_csrf');
