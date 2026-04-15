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
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const body = await zres.json().catch(() => ({}));
    res.status(zres.status).json(body);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
