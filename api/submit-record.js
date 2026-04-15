import { getAccessToken, zohoBase, readJson } from './_zoho.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const form = req.query && req.query.form;
    if (!form) return res.status(400).json({ error: 'Missing form' });
    const payload = await readJson(req);
    const data = payload && payload.data ? payload.data : payload;

    const token = await getAccessToken();
    const url = `${zohoBase()}/form/${encodeURIComponent(form)}`;
    const zres = await fetch(url, {
      method: 'POST',
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
