# OneTrue — Three-project integration, deployment, and validation

## What is included

This update is built on the latest provided source revisions:

- **Backend:** `otli-server-localhost-cors-fixed.zip`
- **Admin:** `onetrue-admin-login-session-fixed.zip`
- **Client:** `onetrue-client-login-session-fixed.zip`

It preserves the existing routes, booking and account-notification flows, access roles, and registration-only OTP sending policy. No Redis, additional packages, or new backend environment variables are required.

### Confirmed integration fixes

1. **Local API mismatch:** Admin and Client defaulted to `http://localhost:5000` while Express uses `PORT=3000`. Both now default to `http://localhost:3000/api` locally.
2. **API/Socket hostname mismatch:** If a deployment sets `VITE_API_URL`, Socket.IO now derives its default origin from that URL. A root API URL without `/api` is normalized automatically.
3. **Hostinger polling support:** Admin and Client now initiate Socket.IO with HTTP polling, then upgrade to WebSocket if the host supports it. Existing event names are unchanged.
4. **Authentication during MongoDB interruption:** Database lookup errors in the `protect` middleware are now sent to the database error handler (503), not misclassified as invalid JWTs (401). Real invalid tokens still receive 401.
5. **MongoDB initial connection:** The HTTP server starts without waiting for initial Atlas connectivity; database endpoints return an explicit 503 until connected. Initial connection failures retry with bounded exponential backoff. Existing MongoDB driver handles subsequent reconnections.
6. **Backend DNS:** Removed the global override of the hosting environment's DNS resolvers, which could break Atlas SRV lookups on networks blocking external DNS.
7. **Login timeout:** Login has a separate 20-second client deadline, no automatic retry. Existing API timings and login diagnostics are retained.
8. **CORS support IDs:** Both API and Socket.IO use the existing allowlist. `X-Request-ID` and `Retry-After` are accessible to browser clients for support diagnostics.
9. **Disabled password-reset emails:** The now-disabled password reset does not show an OTP email form. Clients see instructions to contact support instead. Signed-in password changes continue working.

## Required production endpoints

| System | Expected hostname | Paths |
|---|---|---|
| API | `https://api.onetrue.ph` | `/api/*`, `/health`, `/health/database`, `/socket.io/*` |
| Admin | `https://admin.onetrue.ph` | React site; calls `https://api.onetrue.ph/api` |
| Client | `https://onetrue.ph` | React site; calls `https://api.onetrue.ph/api` |

**Do not assume the API hostname works just because the React websites load.** Verify it in browser/Network and Hostinger DNS/deployment. No source-code change can fix an absent DNS record or an unavailable hosting service.

## Deploy in this order

### 1. Backend on Hostinger Node.js

Back up your current deployment and its private `.env` settings. Deploy the `otli-server` package to the backend Node.js app only.

```bash
npm ci
npm run test:integration
npm start
```

Choose a compatible Node.js version (22 is within the declared engine range). Keep your existing `MONGODB_URI`, `JWT_SECRET`, `PORT`, `CLIENT_ORIGINS`, and Hostinger SMTP variables. **Never upload real secrets in public build artifacts.**

Verify the runtime log shows `[startup] HTTP listening` and `[database] Initial connection established`. Until MongoDB connects, the API returns 503 on protected routes but `/api/test` stays available. If Atlas DNS/authentication or IP allowlisting fails, fix the actual network/credentials instead of increasing frontend request timeouts.

The backend retains the existing email policy: only registration OTP and resend can send SMTP. The existing MongoDB email slot limiter stays active. Booking status updates remain in account notifications.

### 2. Admin React app

Extract `onetrue-admin` into its own frontend build folder. From that folder:

```bash
npm ci
npm run test:integration
npm run build
```

Deploy the resulting `dist/` as the document root of `https://admin.onetrue.ph` (including `dist/.htaccess` if applicable to Apache). Do not upload the admin build to the API Node.js application.

### 3. Client React app

Extract `onetrue-client` into its own frontend build folder. Run:

```bash
npm ci
npm run test:integration
npm run build
```

Deploy its `dist/` to `https://onetrue.ph`. Ensure you are not serving an old cached JS bundle (hard-refresh browsers after deployment).

### Frontend build variables

No new settings are necessary when the backend is actually available at `https://api.onetrue.ph`. Both frontends default to that address in production.

**Only if your backend is at a different URL**, set `VITE_API_URL` to the real backend's `/api` endpoint *before building* each frontend. Set `VITE_SOCKET_URL` only if `/socket.io` is routed differently from the API origin. Rebuild after any Vite environment change; Vite injects variables at build time.

## Local development (one machine)

- Backend: `http://localhost:3000` (`npm run dev`)
- Admin Vite: `http://localhost:5173` (`npm run dev`)
- Client Vite: `http://localhost:5174` (`npm run dev -- --port 5174`)

Leave frontend `VITE_API_URL` and `VITE_SOCKET_URL` unset for these local defaults. Backend CORS is permissive in development, and in production only the origins from `CLIENT_ORIGINS` and built-in OneTrue domains are allowed.

## Check real API connectivity

Run this **read-only, no-credentials** script from the backend project. It does not send OTPs, payments, or bookings:

```bash
node scripts/check-three-projects.cjs http://localhost:3000
node scripts/check-three-projects.cjs https://api.onetrue.ph
```

It checks HTTP health, `/api/test`, MongoDB readiness, login validation using empty fields (400 expected), CORS preflight for both websites and localhost, and the Socket.IO polling handshake. Look for 9/9 passed; if not, the failing probe identifies the category.

### Expected results

| Probe | Healthy response |
|---|---|
| GET `/api/test` | 200 JSON |
| GET `/health/database` | 200 (MongoDB reachable) |
| GET `/health` | 200 (DB and document storage ready) |
| POST `/api/auth/login` with `{}` | 400 (input validation, no account used) |
| OPTIONS `/api/auth/login`, Origin admin/client/localhost | 204 and matching Access-Control-Allow-Origin |
| GET `/socket.io/?EIO=4&transport=polling` | 200, Socket.IO open packet |

After these pass, perform an actual login with a designated **staging** admin and client user, check `/auth/me`, then verify dashboard/booking account notifications. Do not share account passwords, JWTs, or OTPs in screenshots.

## If the first login is still slow

In Chrome DevTools -> Network -> POST `https://api.onetrue.ph/api/auth/login`:

- **(failed) / ERR_NETWORK:** First check the actual API hostname, HTTPS, proxy, DNS, and CORS preflight. Backend code cannot repair an unreachable domain.
- **503 / DATABASE_UNAVAILABLE:** Hostinger can reach Express, but Atlas is disconnected. Inspect MongoDB logs, IP access list, DNS SRV resolution, and credentials.
- **401:** Invalid or expired credentials/JWT; do not treat this as a database outage.
- **200 but delayed:** Check the backend log's `[auth] slow login ... lookupMs=... verifyMs=... totalMs=...` and `X-Request-ID`. Check Atlas indexes and Hostinger CPU limits if lookup or bcrypt is slow.
- **Failed `/socket.io` but REST works:** Verify `/socket.io` polling routes through the same backend app; Hostinger managed hosting may not support WebSocket upgrades.
- **503 from Hostinger before Express:** Check resource usage, Node.js runtime logs, build logs, and backend app routing; this is not a React state problem.

## Testing and limitations

In this environment, **114 automated offline tests passed** (52 backend, 31 admin, 31 client), plus parser validation across **276 JavaScript/JSX files**. They include mocked auth cases, MongoDB retry/failure classification, API URL defaults, CORS, Socket.IO fallback and the public smoke script. No live SMTP sends, bookings, payments, or account logins were triggered.

A complete `npm ci`/Vite production build could not run here because the required packages are not present in the offline npm cache. Hostinger network, DNS, SSL, Atlas, SMTP, and the real API hostname could not be fully verified here. You must run the production builds and the smoke script in the real deployment environment before declaring the system production-ready.

### Remaining operational/security concerns

- The example `/api/users` CRUD routes in the original backend remain unchanged; review whether these test endpoints should be disabled or protected in production.
- Never assume provider SMTP acceptance means email arrived. OTP sends remain rate limited, and no automatic retry of uncertain email delivery is enabled.
- Automated forgot-password email is intentionally disabled; use a verified manual support recovery process.
- Rotate any credentials that have been shared in chats or logs, including MongoDB password, admin password, and JWT secret (JWT rotation will invalidate existing sessions).
- Hostinger managed web/cloud Node.js plans may restrict WebSockets and background processes. The polling fallback is designed for that limitation; the proxy still must forward Socket.IO requests.
