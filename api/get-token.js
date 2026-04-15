import { getAccessToken } from './_zoho.js';

export default async function handler(req, res) {
  try {
    const token = await getAccessToken();
    res.status(200).json({ access_token: token });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
