import { getAccessToken } from './_zoho.js';

export default async function handler(req, res) {
  const apiDomain = process.env.ZOHO_API_DOMAIN || '(default) https://www.zohoapis.com';
  const envPresence = {
    ZOHO_CLIENT_ID: !!process.env.ZOHO_CLIENT_ID,
    ZOHO_CLIENT_SECRET: !!process.env.ZOHO_CLIENT_SECRET,
    ZOHO_REFRESH_TOKEN: !!process.env.ZOHO_REFRESH_TOKEN,
    ZOHO_API_DOMAIN: apiDomain,
    ZOHO_ACCOUNTS_DOMAIN: process.env.ZOHO_ACCOUNTS_DOMAIN || '(auto-derived from ZOHO_API_DOMAIN)',
    ZOHO_ACCOUNT: process.env.ZOHO_ACCOUNT || '(default) jeramoda',
    ZOHO_APP: process.env.ZOHO_APP || '(default) eom'
  };

  try {
    const token = await getAccessToken();
    const masked = token ? token.slice(0, 6) + '...' + token.slice(-4) : null;
    console.log('[get-token] success', { masked, env: envPresence });
    res.status(200).json({ ok: true, access_token_masked: masked, env: envPresence });
  } catch (err) {
    const detail = {
      message: err.message || String(err),
      httpStatus: err.status || null,
      tokenUrl: err.tokenUrl || null,
      upstream: err.upstream || null,
      env: envPresence
    };
    console.error('[get-token] FAILED', detail);
    res.status(500).json({ error: detail.message, detail });
  }
}
