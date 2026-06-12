import { zohoBase, zohoFetch, query, json } from './_zoho.js';

export async function onRequest({ request, env }) {
  try {
    const q = query(request);
    const report = q.get('report');
    if (!report) return json({ error: 'Missing report' }, 400);

    const criteria = q.get('criteria') || '';
    const record_cursor = q.get('record_cursor') || '';

    const url = `${zohoBase(env)}/report/${encodeURIComponent(report)}?max_records=200`
      + (criteria ? `&criteria=${encodeURIComponent(criteria)}` : '');

    const zohoHeaders = { Accept: 'application/json' };
    if (record_cursor) zohoHeaders['record_cursor'] = record_cursor;

    const zres = await zohoFetch(env, url, { headers: zohoHeaders });
    const raw = await zres.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }
    if (!zres.ok) {
      if (zres.status === 400) {
        console.log('[get-records] 400 from Zoho — treating as empty result:', raw.slice(0, 200));
        return json({ code: 3000, data: [], message: 'Empty result (400 treated as success)' });
      }
      console.error('[get-records] upstream', { status: zres.status, url, body });
      return json({ error: 'Zoho API ' + zres.status, url, upstream: body }, zres.status);
    }
    const nextCursor = zres.headers.get('record_cursor') || null;
    return json({ ...body, record_cursor: nextCursor });
  } catch (err) {
    console.error('[get-records] error', err);
    return json({ error: err.message || String(err), upstream: err.upstream || null, tokenUrl: err.tokenUrl || null }, 500);
  }
}
