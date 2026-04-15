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

    console.log('[submit-record] POST', { url, fields: Object.keys(data || {}) });

    const zres = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Zoho-oauthtoken ${token}`
      },
      body: JSON.stringify({ data })
    });
    const raw = await zres.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }

    if (!zres.ok || (body && body.code && body.code !== 3000)) {
      console.error('[submit-record] upstream failure', { status: zres.status, url, upstream: body });
      return res.status(zres.status || 500).json({ error: 'Zoho API ' + zres.status, url, upstream: body });
    }
    res.status(200).json(body);
  } catch (err) {
    console.error('[submit-record] error', err);
    res.status(500).json({ error: err.message || String(err), upstream: err.upstream || null, tokenUrl: err.tokenUrl || null });
  }
}
