// Image proxy for Zoho-hosted images.
//
// Zoho Creator image field URLs require an OAuth token header — they can't be
// loaded directly in <img src="..."> from the browser. This endpoint fetches
// the image server-side (reusing the cached token from _zoho.js) and streams
// the bytes back with a long Cache-Control header so the browser caches them.
//
// SECURITY: Only Zoho domains are allowed (no open proxy). The URL allowlist
// checks that the host is exactly a Zoho domain or a subdomain of one.

import { zohoFetch, query, json } from './_zoho.js';

const ALLOWED_SUFFIXES = ['.zohoapis.com', '.zoho.com', '.zohostatic.com', '.zohocdn.com'];

function isZohoUrl(raw) {
  try {
    const { hostname } = new URL(raw);
    if (hostname === 'zoho.com' || hostname === 'zohoapis.com') return true;
    return ALLOWED_SUFFIXES.some((s) => hostname.endsWith(s));
  } catch (_) {
    return false;
  }
}

export async function onRequest({ request, env }) {
  const q = query(request);
  const imageUrl = q.get('url');

  if (!imageUrl) return json({ error: 'Missing url parameter' }, 400);
  if (!isZohoUrl(imageUrl)) return json({ error: 'Forbidden: URL must be a Zoho domain' }, 403);

  try {
    const upstream = await zohoFetch(env, imageUrl, { method: 'GET' });

    if (!upstream.ok) {
      const status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
      return json({ error: 'Upstream returned ' + upstream.status }, status);
    }

    const ct = upstream.headers.get('Content-Type') || 'image/jpeg';
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (err) {
    return json({ error: 'Image fetch error: ' + String(err && err.message) }, 502);
  }
}
