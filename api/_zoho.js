let cachedToken = null;
let cachedExp = 0;

export async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExp) return cachedToken;

  const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } = process.env;
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    throw new Error('Missing Zoho OAuth env vars');
  }

  const params = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });

  const tokenUrl = 'https://accounts.zoho.com/oauth/v2/token';
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  const rawText = await res.text();
  let body = null;
  try { body = rawText ? JSON.parse(rawText) : null; } catch { body = { raw: rawText }; }

  console.log('[zoho oauth] status=' + res.status, {
    clientIdTail: ZOHO_CLIENT_ID.slice(-6),
    refreshTail: ZOHO_REFRESH_TOKEN.slice(-6),
    body
  });

  if (!res.ok || !body || !body.access_token) {
    const err = new Error('Zoho token refresh failed (HTTP ' + res.status + ')');
    err.status = res.status;
    err.upstream = body;
    throw err;
  }

  cachedToken = body.access_token;
  cachedExp = now + 50 * 60 * 1000;
  return cachedToken;
}

export function zohoBase() {
  const domain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
  const account = process.env.ZOHO_ACCOUNT || 'jeramoda';
  const app = process.env.ZOHO_APP || 'eom';
  return `${domain}/creator/v2.1/data/${account}/${app}`;
}

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
