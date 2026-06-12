import { zohoBase, zohoFetch, readJson, query, json } from './_zoho.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'PATCH') {
    return json({ error: 'Method not allowed' }, 405, { Allow: 'PATCH' });
  }
  try {
    const q = query(request);
    const report = q.get('report');
    const id = q.get('id');
    if (!report || !id) return json({ error: 'Missing report or id' }, 400);
    const payload = await readJson(request);
    const data = payload && payload.data ? payload.data : payload;

    const url = `${zohoBase(env)}/report/${encodeURIComponent(report)}/${encodeURIComponent(id)}`;
    console.log('[update-record] PATCH', { url, fields: Object.keys(data || {}) });

    const zres = await zohoFetch(env, url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ data }),
    });
    const raw = await zres.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }

    if (!zres.ok || (body && body.code && body.code !== 3000)) {
      console.error('[update-record] upstream failure', {
        status: zres.status,
        url,
        sentFields: Object.keys(data || {}),
        upstream: body,
      });
      return json({
        error: 'Zoho API ' + zres.status,
        url,
        sentFields: Object.keys(data || {}),
        upstream: body,
      }, zres.status || 500);
    }
    return json(body);
  } catch (err) {
    // Write failure — surface clearly so the client knows the update did NOT
    // persist and can retry (prevents silent data loss).
    console.error('[update-record] error', err);
    return json({
      error: '更新失败 (Zoho): ' + (err.message || String(err)),
      saved: false,
      upstream: err.upstream || null,
      tokenUrl: err.tokenUrl || null,
    }, 500);
  }
}
