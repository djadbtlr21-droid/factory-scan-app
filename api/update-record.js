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

    console.log('[update-record] PATCH', { url, fields: Object.keys(data || {}) });

    const zres = await fetch(url, {
      method: 'PATCH',
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
      console.error('[update-record] upstream failure', {
        status: zres.status,
        url,
        sentFields: Object.keys(data || {}),
        upstream: body
      });
      return res.status(zres.status || 500).json({
        error: 'Zoho API ' + zres.status,
        url,
        sentFields: Object.keys(data || {}),
        upstream: body
      });
    }
    res.status(200).json(body);
  } catch (err) {
    console.error('[update-record] error', err);
    res.status(500).json({ error: err.message || String(err), upstream: err.upstream || null, tokenUrl: err.tokenUrl || null });
  }
}
