import { getAccessToken, zohoBase } from './_zoho.js';

export default async function handler(req, res) {
  try {
    const report = req.query && req.query.report;
    if (!report) return res.status(400).json({ error: 'Missing report' });
    const page = (req.query && req.query.page) || '1';
    const perPage = (req.query && req.query.per_page) || '100';

    const token = await getAccessToken();
    const url = `${zohoBase()}/report/${encodeURIComponent(report)}?page=${encodeURIComponent(page)}&per_page=${encodeURIComponent(perPage)}`;
    const zres = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: 'application/json' }
    });
    const raw = await zres.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }
    if (!zres.ok) {
      console.error('[get-records] upstream', { status: zres.status, url, body });
      return res.status(zres.status).json({ error: 'Zoho API ' + zres.status, url, upstream: body });
    }
    res.status(200).json(body);
  } catch (err) {
    console.error('[get-records] error', err);
    res.status(500).json({ error: err.message || String(err), upstream: err.upstream || null, tokenUrl: err.tokenUrl || null });
  }
}
