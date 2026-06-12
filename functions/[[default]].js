// SPA fallback for EdgeOne Pages.
//
// QR scans open deep links like /view/inner/:uuid and /view/bag/:uuid directly.
// This app parses location.pathname itself (no react-router), so the server must
// serve index.html for any non-asset, non-API path — otherwise refresh/direct
// entry 404s.
//
// Why this works as a catch-all without shadowing anything:
//   • EdgeOne routes static assets BEFORE functions, so /index.html, /assets/*,
//     /manifest.json, icons, sw.js etc. are still served as files.
//   • More-specific function routes win, so /api/* keeps hitting functions/api/*.
//   • Only paths with no static file and no specific function (i.e. /view/...,
//     and any other client route) fall through to here.
//
// NOTE: The cleaner alternative is to enable "SPA fallback / rewrite to
// index.html" in the EdgeOne Pages console (Project → Settings). If you enable
// that, this file is redundant and can be removed. See functions/README.md.

export async function onRequest({ request }) {
  const url = new URL(request.url);

  // Fetch the built index.html as a static asset (static priority means this
  // does NOT re-enter this function), then return it for the requested route.
  const indexRes = await fetch(new URL('/index.html', url.origin).toString());

  return new Response(indexRes.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-cache',
    },
  });
}
