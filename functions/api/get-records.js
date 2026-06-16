import { zohoBase, zohoFetch, query, json } from './_zoho.js';

export async function onRequest({ request, env }) {
  try {
    const q = query(request);
    const report = q.get('report');
    if (!report) return json({ error: 'Missing report' }, 400);

    const criteria = q.get('criteria') || '';
    const record_cursor = q.get('record_cursor') || '';

    const maxRecords = parseInt(q.get('max_records') || '200', 10) || 200;
    const sortBy = q.get('sort_by') || '';
    const sortOrder = q.get('sort_order') || '';
    const url = `${zohoBase(env)}/report/${encodeURIComponent(report)}?max_records=${maxRecords}`
      + (criteria ? `&criteria=${encodeURIComponent(criteria)}` : '')
      + (sortBy ? `&sort_by=${encodeURIComponent(sortBy)}` : '')
      + (sortOrder ? `&sort_order=${encodeURIComponent(sortOrder)}` : '');

    const zohoHeaders = { Accept: 'application/json' };
    if (record_cursor) zohoHeaders['record_cursor'] = record_cursor;

    if (report === 'Production_Log_Report') {
      console.log('[PLR-debug] Zoho URL:', url);
    }

    const zres = await zohoFetch(env, url, { headers: zohoHeaders });
    const raw = await zres.text();

    if (report === 'Production_Log_Report') {
      console.log('[PLR-debug] status:', zres.status, '| body[:500]:', raw.slice(0, 500));
    }
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }
    if (!zres.ok) {
      console.error('[get-records] upstream', { status: zres.status, url, body: raw.slice(0, 500) });
      return json({ error: 'Zoho API ' + zres.status, upstream: body }, zres.status);
    }
    const nextCursor = zres.headers.get('record_cursor') || null;
    return json({ ...body, record_cursor: nextCursor });
  } catch (err) {
    console.error('[get-records] error', err);
    return json({ error: err.message || String(err), upstream: err.upstream || null, tokenUrl: err.tokenUrl || null }, 500);
  }
}
