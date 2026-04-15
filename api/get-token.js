import { getAccessToken, zohoBase, zohoApiVersion, lastTokenMeta } from './_zoho.js';

export default async function handler(req, res) {
  const envPresence = {
    ZOHO_CLIENT_ID: !!process.env.ZOHO_CLIENT_ID,
    ZOHO_CLIENT_SECRET: !!process.env.ZOHO_CLIENT_SECRET,
    ZOHO_REFRESH_TOKEN: !!process.env.ZOHO_REFRESH_TOKEN,
    ZOHO_API_DOMAIN: process.env.ZOHO_API_DOMAIN || '(default) https://www.zohoapis.com',
    ZOHO_ACCOUNTS_DOMAIN: process.env.ZOHO_ACCOUNTS_DOMAIN || '(auto-derived from ZOHO_API_DOMAIN)',
    ZOHO_ACCOUNT: process.env.ZOHO_ACCOUNT || '(default) jeramoda',
    ZOHO_APP: process.env.ZOHO_APP || '(default) eom',
    ZOHO_API_VERSION: zohoApiVersion()
  };

  try {
    const token = await getAccessToken();
    const masked = token ? token.slice(0, 6) + '...' + token.slice(-4) : null;
    const meta = lastTokenMeta();
    const sampleUrl = `${zohoBase()}/report/All_MO?page=1&per_page=1`;
    const scopeList = (meta && meta.scope) ? String(meta.scope).split(/[\s,]+/).filter(Boolean) : [];
    const scopeCovers = {
      'ZohoCreator.report.READ': scopeList.some((s) => /^ZohoCreator\.(report|data)\.(READ|ALL)$/i.test(s)),
      'ZohoCreator.form.CREATE': scopeList.some((s) => /^ZohoCreator\.(form|data)\.(CREATE|ALL)$/i.test(s)),
      'ZohoCreator.report.UPDATE': scopeList.some((s) => /^ZohoCreator\.(report|data)\.(UPDATE|ALL)$/i.test(s))
    };
    console.log('[get-token] success', { masked, env: envPresence, meta, scopeCovers });
    res.status(200).json({
      ok: true,
      access_token_masked: masked,
      refresh_meta: meta,
      scope_list: scopeList,
      scope_covers_required_calls: scopeCovers,
      sample_data_url: sampleUrl,
      env: envPresence
    });
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
