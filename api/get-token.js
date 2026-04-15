import { getAccessToken } from './_zoho.js';

export default async function handler(req, res) {
  const envPresence = {
    ZOHO_CLIENT_ID: !!process.env.ZOHO_CLIENT_ID,
    ZOHO_CLIENT_SECRET: !!process.env.ZOHO_CLIENT_SECRET,
    ZOHO_REFRESH_TOKEN: !!process.env.ZOHO_REFRESH_TOKEN,
    ZOHO_API_DOMAIN: process.env.ZOHO_API_DOMAIN || '(default)',
    ZOHO_ACCOUNT: process.env.ZOHO_ACCOUNT || '(default)',
    ZOHO_APP: process.env.ZOHO_APP || '(default)'
  };

  try {
    const token = await getAccessToken();
    const masked = token ? token.slice(0, 6) + '...' + token.slice(-4) : null;
    console.log('[get-token] success', { masked, env: envPresence });
    res.status(200).json({ access_token: token, env: envPresence });
  } catch (err) {
    const detail = {
      message: err.message || String(err),
      status: err.status || null,
      upstream: err.upstream || null,
      env: envPresence
    };
    console.error('[get-token] FAILED', detail);
    res.status(500).json({ error: detail.message, detail });
  }
}
