// Shared Zoho helpers for EdgeOne Pages Functions.
//
// This mirrors api/_zoho.js (Vercel) but adapted to the EdgeOne edge runtime:
//   - env vars come from the `env` argument, not process.env
//   - the Zoho access token is cached in EdgeOne KV (binding name SCAN_KV)
//     so it survives across isolates, with an in-memory fast path on top.
//
// NOTE: this file is a shared module, NOT a route handler (no onRequest export).
// EdgeOne / Cloudflare-style Pages Functions import it from sibling route files
// via `import { ... } from './_zoho.js'`. The leading underscore keeps it from
// being treated as a public route.

// ── In-memory fast path (per-isolate, best-effort) ──────────────────────────
let memToken = null;
let memExp = 0;

// EdgeOne KV keys allow only [0-9A-Za-z_] — a ':' (as in the Vercel spec
// "zoho:access_token") is rejected, so we use an underscore form here.
const KV_TOKEN_KEY = 'zoho_access_token';
const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 min (Zoho tokens live 60 min)

// ── Safe KV accessor (verified pattern from IKU-dashboard) ──────────────────
// ① env?.SCAN_KV → ② globalThis.SCAN_KV → ③ bare global SCAN_KV → null
function getKV(env) {
  try {
    if (env && env.SCAN_KV) return env.SCAN_KV;
  } catch (_) { /* ignore */ }
  try {
    if (typeof globalThis !== 'undefined' && globalThis.SCAN_KV) return globalThis.SCAN_KV;
  } catch (_) { /* ignore */ }
  try {
    // eslint-disable-next-line no-undef
    if (typeof SCAN_KV !== 'undefined') return SCAN_KV;
  } catch (_) { /* ignore */ }
  return null;
}

async function kvReadToken(env) {
  const kv = getKV(env);
  if (!kv) return null;
  try {
    const raw = await kv.get(KV_TOKEN_KEY);
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && parsed.token && parsed.expiresAt) return parsed;
  } catch (e) {
    console.warn('[zoho] KV read failed, falling back to refresh:', e && e.message);
  }
  return null;
}

async function kvWriteToken(env, token, expiresAt) {
  const kv = getKV(env);
  if (!kv) return;
  try {
    await kv.put(KV_TOKEN_KEY, JSON.stringify({ token, expiresAt }));
  } catch (e) {
    console.warn('[zoho] KV write failed (token still works this request):', e && e.message);
  }
}

async function kvDeleteToken(env) {
  const kv = getKV(env);
  if (!kv) return;
  try {
    await kv.delete(KV_TOKEN_KEY);
  } catch (e) {
    console.warn('[zoho] KV delete failed:', e && e.message);
  }
}

// ── Zoho domain helpers (env-based) ─────────────────────────────────────────
function accountsDomain(env) {
  const explicit = env.ZOHO_ACCOUNTS_DOMAIN;
  if (explicit) return explicit.replace(/^https?:\/\//, '').replace(/\/+$/, '');

  const api = (env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  const m = api.match(/zohoapis\.(.+)$/i);
  const tld = m ? m[1] : 'com';
  return 'accounts.zoho.' + tld;
}

export function zohoBase(env) {
  const domain = (env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com').replace(/\/+$/, '');
  const account = env.ZOHO_ACCOUNT || 'jeramoda';
  const app = env.ZOHO_APP || 'eom';
  const version = (env.ZOHO_API_VERSION || 'v2.1').replace(/^\/+|\/+$/g, '');
  return `${domain}/creator/${version}/data/${account}/${app}`;
}

export function zohoApiVersion(env) {
  return (env.ZOHO_API_VERSION || 'v2.1').replace(/^\/+|\/+$/g, '');
}

let lastMeta = null;
export function lastTokenMeta() {
  return lastMeta;
}

// Force a refresh against Zoho's OAuth endpoint and repopulate every cache layer.
async function refreshToken(env) {
  const now = Date.now();
  const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } = env;
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    const err = new Error('Missing Zoho OAuth env vars');
    err.status = 500;
    err.upstream = {
      ZOHO_CLIENT_ID: !!ZOHO_CLIENT_ID,
      ZOHO_CLIENT_SECRET: !!ZOHO_CLIENT_SECRET,
      ZOHO_REFRESH_TOKEN: !!ZOHO_REFRESH_TOKEN,
    };
    throw err;
  }

  const params = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });

  const host = accountsDomain(env);
  const tokenUrl = 'https://' + host + '/oauth/v2/token';

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  const rawText = await res.text();
  let body = null;
  try { body = rawText ? JSON.parse(rawText) : null; } catch { body = { raw: rawText }; }

  // Zoho returns HTTP 200 with {error:"..."} on credential problems,
  // and HTTP 4xx/5xx on transport problems. Treat both as failure.
  if (!res.ok || !body || body.error || !body.access_token) {
    const err = new Error('Zoho token refresh failed: ' + (body && body.error ? body.error : 'HTTP ' + res.status));
    err.status = res.status;
    err.upstream = body;
    err.tokenUrl = tokenUrl;
    throw err;
  }

  const token = body.access_token;
  const expiresAt = now + TOKEN_TTL_MS;
  memToken = token;
  memExp = expiresAt;
  lastMeta = {
    tokenUrl,
    scope: body.scope || null,
    api_domain: body.api_domain || null,
    token_type: body.token_type || null,
    expires_in: body.expires_in || null,
    refreshed_at: new Date(now).toISOString(),
  };
  await kvWriteToken(env, token, expiresAt);
  return token;
}

// Get a usable access token, using (in order): in-memory cache → KV cache →
// fresh refresh. `force` skips both caches (used after a 401).
export async function getAccessToken(env, force = false) {
  const now = Date.now();

  if (!force) {
    if (memToken && now < memExp) {
      return memToken;
    }
    const kvToken = await kvReadToken(env);
    if (kvToken && now < kvToken.expiresAt) {
      memToken = kvToken.token;
      memExp = kvToken.expiresAt;
      return memToken;
    }
  }

  return refreshToken(env);
}

// Drop every cache layer so the next getAccessToken() refreshes.
export async function invalidateToken(env) {
  memToken = null;
  memExp = 0;
  await kvDeleteToken(env);
}

// Authenticated fetch to Zoho with one automatic retry on 401:
// 401 → invalidate caches → force-refresh token → retry exactly once.
export async function zohoFetch(env, url, init = {}) {
  const doFetch = async (token) => {
    const headers = { ...(init.headers || {}), Authorization: `Zoho-oauthtoken ${token}` };
    return fetch(url, { ...init, headers });
  };

  let token = await getAccessToken(env);
  let res = await doFetch(token);
  if (res.status === 401) {
    console.warn('[zoho] 401 — invalidating token cache and retrying once');
    await invalidateToken(env);
    token = await getAccessToken(env, true);
    res = await doFetch(token);
  }
  return res;
}

// ── Request/response helpers ────────────────────────────────────────────────
export async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function query(request) {
  return new URL(request.url).searchParams;
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', ...extraHeaders },
  });
}
