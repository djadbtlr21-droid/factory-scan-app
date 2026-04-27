import { getAccessToken, zohoBase } from './_zoho.js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const report = req.query && req.query.report;
    const id = req.query && req.query.id;
    if (!report || !id) return res.status(400).json({ error: 'Missing report or id' });

    const token = await getAccessToken();
    const url = `${zohoBase()}/report/${encodeURIComponent(report)}/${encodeURIComponent(id)}`;

    console.log('[delete-record] DELETE', { url });

    const zres = await fetch(url, {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        Authorization: `Zoho-oauthtoken ${token}`
      }
    });
    const raw = await zres.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }

    if (!zres.ok || (body && body.code && body.code !== 3000)) {
      console.error('[delete-record] upstream failure', { status: zres.status, url, upstream: body });
      return res.status(zres.status || 500).json({ error: 'Zoho API ' + zres.status, url, upstream: body });
    }
    res.status(200).json(body || { code: 3000 });
  } catch (err) {
    console.error('[delete-record] error', err);
    res.status(500).json({ error: err.message || String(err) });
  }
}
