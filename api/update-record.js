import { getAccessToken, zohoBase, readJson } from './_zoho.js';

export default async function handler(req, res) {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const report = req.query && req.query.report;
    const id = req.query && req.query.id;
    if (!report || !id) return res.status(400).json({ error: 'Missing report or id' });
    const payload = await readJson(req);
    const data = payload && payload.data ? payload.data : payload;

    const token = await getAccessToken();
    const url = `${zohoBase()}/report/${encodeURIComponent(report)}/${encodeURIComponent(id)}`;
    const zres = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Zoho-oauthtoken ${token}`
      },
      body: JSON.stringify({ data })
    });
    const body = await zres.json().catch(() => ({}));
    res.status(zres.status).json(body);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
