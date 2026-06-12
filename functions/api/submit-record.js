import { zohoBase, zohoFetch, readJson, query, json } from './_zoho.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
  }
  try {
    const form = query(request).get('form');
    if (!form) return json({ error: 'Missing form' }, 400);
    const payload = await readJson(request);
    const data = payload && payload.data ? payload.data : payload;

    const url = `${zohoBase(env)}/form/${encodeURIComponent(form)}`;
    console.log('[submit-record] POST', { url, fields: Object.keys(data || {}) });

    const zres = await zohoFetch(env, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ data }),
    });
    const raw = await zres.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }

    if (!zres.ok || (body && body.code && body.code !== 3000)) {
      console.error('[submit-record] upstream failure', { status: zres.status, url, upstream: body });
      return json({ error: 'Zoho API ' + zres.status, url, upstream: body }, zres.status || 500);
    }
    return json(body);
  } catch (err) {
    // Write failure — surface clearly so the client knows the record was NOT
    // saved and can retry (prevents silent data loss).
    console.error('[submit-record] error', err);
    return json({
      error: '保存失败 (Zoho): ' + (err.message || String(err)),
      saved: false,
      upstream: err.upstream || null,
      tokenUrl: err.tokenUrl || null,
    }, 500);
  }
}
