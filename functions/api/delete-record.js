import { zohoBase, zohoFetch, query, json } from './_zoho.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'DELETE') {
    return json({ error: 'Method not allowed' }, 405, { Allow: 'DELETE' });
  }
  try {
    const q = query(request);
    const report = q.get('report');
    const id = q.get('id');
    if (!report || !id) return json({ error: 'Missing report or id' }, 400);

    const url = `${zohoBase(env)}/report/${encodeURIComponent(report)}/${encodeURIComponent(id)}`;
    console.log('[delete-record] DELETE', { url });

    const zres = await zohoFetch(env, url, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    const raw = await zres.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }

    if (!zres.ok || (body && body.code && body.code !== 3000)) {
      console.error('[delete-record] upstream failure', { status: zres.status, url, upstream: body });
      return json({ error: 'Zoho API ' + zres.status, url, upstream: body }, zres.status || 500);
    }
    return json(body || { code: 3000 });
  } catch (err) {
    console.error('[delete-record] error', err);
    return json({ error: err.message || String(err) }, 500);
  }
}
