import { getAccessToken, zohoBase } from './_zoho.js';

export default async function handler(req, res) {
  try {
    const report = req.query && req.query.report;
    if (!report) return res.status(400).json({ error: 'Missing report' });

    // Zoho Creator v2.1 pagination: from (1-based) + limit (max 200).
    // Legacy page/per_page are rejected with {code:1060,"Invalid request parameter found - page"}.
    const from = (req.query && req.query.from) || '1';
    const limitRaw = parseInt((req.query && req.query.limit) || '200', 10);
    const limit = String(Math.max(1, Math.min(isNaN(limitRaw) ? 200 : limitRaw, 200)));

    const token = await getAccessToken();
    const url = `${zohoBase()}/report/${encodeURIComponent(report)}?from=${encodeURIComponent(from)}&limit=${encodeURIComponent(limit)}`;
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
