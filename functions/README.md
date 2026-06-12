# EdgeOne Pages Functions

EdgeOne Pages port of the Vercel `/api` serverless functions. The original `/api`
folder is **unchanged** and still powers the Vercel deployment — this `/functions`
folder runs the same logic on EdgeOne Pages with identical URL paths.

## Route mapping

EdgeOne Pages uses file-based routing (`functions/<path>.js` → `/<path>`). Each
function keeps the exact same URL the frontend already calls:

| URL path              | Vercel file              | EdgeOne file                   |
| --------------------- | ------------------------ | ------------------------------ |
| `/api/get-token`      | `api/get-token.js`       | `functions/api/get-token.js`   |
| `/api/get-records`    | `api/get-records.js`     | `functions/api/get-records.js` |
| `/api/submit-record`  | `api/submit-record.js`   | `functions/api/submit-record.js` |
| `/api/update-record`  | `api/update-record.js`   | `functions/api/update-record.js` |
| `/api/delete-record`  | `api/delete-record.js`   | `functions/api/delete-record.js` |
| _(everything else)_   | `vercel.json` rewrite    | `functions/[[default]].js` (SPA fallback) |

`functions/api/_zoho.js` is a **shared module** (no `onRequest` export, leading
underscore) imported by the route files — it is not a public route.

Handler shape: `export async function onRequest({ request, env })`, returning a
`Response`. `req.query.x` → `new URL(request.url).searchParams.get('x')`;
`req.body` → `await request.json()`; `process.env.X` → `env.X`.

## Required environment variables

Set these in **EdgeOne Pages → Project → Settings → Environment Variables**
(same values as the Vercel project):

| Variable               | Required | Default                     |
| ---------------------- | -------- | --------------------------- |
| `ZOHO_CLIENT_ID`       | ✅       | —                           |
| `ZOHO_CLIENT_SECRET`   | ✅       | —                           |
| `ZOHO_REFRESH_TOKEN`   | ✅       | —                           |
| `ZOHO_API_DOMAIN`      | ⬜       | `https://www.zohoapis.com`  |
| `ZOHO_ACCOUNTS_DOMAIN` | ⬜       | auto-derived from API domain |
| `ZOHO_ACCOUNT`         | ⬜       | `jeramoda`                  |
| `ZOHO_APP`             | ⬜       | `eom`                       |
| `ZOHO_API_VERSION`     | ⬜       | `v2.1`                      |

Frontend build var (set in the same place, applied at build time):

| Variable             | Purpose                                              |
| -------------------- | --------------------------------------------------- |
| `VITE_APP_BASE_URL`  | Base URL baked into QR/Excel labels (e.g. `https://scan.jera-iku.top`). Falls back to `window.location.origin` if unset. |

## KV binding (token cache)

The Zoho access token is cached in EdgeOne KV so it survives across isolates,
with an in-memory fast path on top.

1. Create a KV namespace in the EdgeOne console.
2. **Bind it to this project with the variable name `SCAN_KV`.**

The functions reach KV through a safe accessor that tries, in order:
`env.SCAN_KV` → `globalThis.SCAN_KV` → bare global `SCAN_KV` → `null`. If KV is
unbound or unavailable, the code **gracefully falls back** to refreshing the
token on every request (no hard failure).

Cache details (`functions/api/_zoho.js`):
- Key: `zoho_access_token` (EdgeOne KV keys allow only letters/digits/`_`, so the
  Vercel-spec `zoho:access_token` colon form is replaced with an underscore).
- Value: `{ token, expiresAt }` where `expiresAt = now + 50 min` (Zoho tokens
  live 60 min). EdgeOne KV has **no native TTL**, so expiry is enforced by the
  `expiresAt` field in the value.
- On a Zoho `401`, the cache is invalidated and the token is refreshed **once**
  before retrying the request.
- Write operations (`submit-record` / `update-record`) return an explicit
  `{ error, saved: false }` on token/Zoho failure so the client can re-submit
  (prevents silent data loss).

## SPA fallback

QR scans hit `/view/inner/:uuid` and `/view/bag/:uuid` directly, and the app
parses the path client-side — so the server must serve `index.html` for any
non-asset, non-API route. Two options (pick one):

1. **Console toggle (recommended).** In EdgeOne Pages → Project → Settings,
   enable the SPA / "rewrite all requests to `index.html`" option. If you use
   this, delete `functions/[[default]].js`.
2. **Code-based catch-all (included).** `functions/[[default]].js` serves
   `index.html` for unmatched routes. Static assets are routed before functions
   and `/api/*` matches more-specific function routes, so the catch-all only
   fires for client routes like `/view/...`.

(The Vercel deployment handles this via the existing root `vercel.json` rewrite,
which is untouched. `/functions` is inert on Vercel.)

## Batch creation note

Inner Pack (up to ~400) and Master Bag batch creation loop **on the client**
(`handleBatchCreatePacks` etc. in `src/App.jsx`) — each server call writes a
single record. There is no long server-side loop, so EdgeOne's per-invocation
CPU limit is not a concern and no chunking changes were needed. Each function
makes one Zoho request and returns.
