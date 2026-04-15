let cachedToken = null;
let cachedExp = 0;

function accountsDomain() {
  const explicit = process.env.ZOHO_ACCOUNTS_DOMAIN;
  if (explicit) return explicit.replace(/^https?:\/\//, '').replace(/\/+$/, '');

  const api = (process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  const m = api.match(/zohoapis\.(.+)$/i);
  const tld = m ? m[1] : 'com';
  return 'accounts.zoho.' + tld;
}

export async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExp) return cachedToken;

  const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } = process.env;
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    const err = new Error('Missing Zoho OAuth env vars');
    err.status = 500;
    err.upstream = {
      ZOHO_CLIENT_ID: !!ZOHO_CLIENT_ID,
      ZOHO_CLIENT_SECRET: !!ZOHO_CLIENT_SECRET,
      ZOHO_REFRESH_TOKEN: !!ZOHO_REFRESH_TOKEN
    };
    throw err;
  }

  const params = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });

  const host = accountsDomain();
  const tokenUrl = 'https://' + host + '/oauth/v2/token';

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: params.toString()
  });

  const rawText = await res.text();
  let body = null;
  try { body = rawText ? JSON.parse(rawText) : null; } catch { body = { raw: rawText }; }

  console.log('[zoho oauth]', {
    tokenUrl,
    httpStatus: res.status,
    clientIdTail: ZOHO_CLIENT_ID.slice(-6),
    refreshTail: ZOHO_REFRESH_TOKEN.slice(-6),
    body
  });

  // Zoho returns HTTP 200 with {error:"..."} on credential problems,
  // and HTTP 4xx/5xx on transport problems. Treat both as failure.
  if (!res.ok || !body || body.error || !body.access_token) {
    const err = new Error('Zoho token refresh failed: ' + (body && body.error ? body.error : 'HTTP ' + res.status));
    err.status = res.status;
    err.upstream = body;
    err.tokenUrl = tokenUrl;
    throw err;
  }

  cachedToken = body.access_token;
  cachedExp = now + 50 * 60 * 1000;
  lastMeta = {
    tokenUrl,
    scope: body.scope || null,
    api_domain: body.api_domain || null,
    token_type: body.token_type || null,
    expires_in: body.expires_in || null,
    refreshed_at: new Date(now).toISOString()
  };
  return cachedToken;
}

export function zohoBase() {
  const domain = (process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com').replace(/\/+$/, '');
  const account = process.env.ZOHO_ACCOUNT || 'jeramoda';
  const app = process.env.ZOHO_APP || 'eom';
  const version = (process.env.ZOHO_API_VERSION || 'v2.1').replace(/^\/+|\/+$/g, '');
  return `${domain}/creator/${version}/data/${account}/${app}`;
}

export function zohoApiVersion() {
  return (process.env.ZOHO_API_VERSION || 'v2.1').replace(/^\/+|\/+$/g, '');
}

export function lastTokenMeta() {
  return lastMeta;
}

let lastMeta = null;

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
