import { getAccessToken, zohoBase } from './_zoho.js';

export default async function handler(req, res) {
  try {
    const report = req.query && req.query.report;
    if (!report) return res.status(400).json({ error: 'Missing report' });

    const criteria = (req.query && req.query.criteria) || '';
    const record_cursor = (req.query && req.query.record_cursor) || '';

    const token = await getAccessToken();
    const url = `${zohoBase()}/report/${encodeURIComponent(report)}?max_records=200`
      + (criteria ? `&criteria=${encodeURIComponent(criteria)}` : '');

    const zohoHeaders = { Authorization: `Zoho-oauthtoken ${token}`, Accept: 'application/json' };
    if (record_cursor) zohoHeaders['record_cursor'] = record_cursor;

    const zres = await fetch(url, { headers: zohoHeaders });
    const raw = await zres.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }
    if (!zres.ok) {
      console.error('[get-records] upstream', { status: zres.status, url, body });
      return res.status(zres.status).json({ error: 'Zoho API ' + zres.status, url, upstream: body });
    }
    const nextCursor = zres.headers.get('record_cursor') || null;
    res.status(200).json({ ...body, record_cursor: nextCursor });
  } catch (err) {
    console.error('[get-records] error', err);
    res.status(500).json({ error: err.message || String(err), upstream: err.upstream || null, tokenUrl: err.tokenUrl || null });
  }
}
