> Historical setup note from the earlier patch. For this latest package, also read **API_TIMEOUT_DIAGNOSTICS.md** (which adds shared API diagnostics and updates `server.js`).

# OTLI Express server: registration emails only

This archive was built directly from the **newly uploaded `otli-server.zip`**. It is a minimal email-only update, **not** the previous BullMQ/Redis or CORS-modified project.

## SMTP sending allowed

- `POST /api/auth/client/register/request-otp` — sends one registration verification OTP when the request is valid and the limit permits it.
- `POST /api/auth/client/register/resend-otp` — sends another registration OTP only for a pending registration and after the existing `EMAIL_OTP_RESEND_SECONDS` cooldown (default 60 seconds).

Both paths retain the original OTP template and SMTP settings.

## SMTP sending removed

- All booking, gate-in/out, billing, payment, status, and admin booking emails have been removed.
- `POST /api/auth/forgot-password` returns HTTP **410 Gone** and sends no email.
- `POST /api/auth/reset-password` returns HTTP **410 Gone**; the previous email OTP recovery process is no longer available.
- `POST /api/auth/email/test` returns HTTP **410 Gone**, including in development.

Authenticated `PATCH /api/auth/change-password` continues to work. **Plan an administrator-assisted account recovery process and remove the forgot-password option from your frontend**, since password recovery via email is disabled.

## Kept unchanged

- Booking status **in-app** notifications via `createClientNotification`.
- Existing admin/user Socket.IO booking events.
- API route paths, login, registration verification logic, permissions, models, startup, CORS, existing package dependencies and package lock.
- No new `.env` variables. No Redis. No added npm packages.

## Built-in sending limit

Because this system sends through one SMTP account, a small MongoDB-backed limiter protects registration OTP messages with rolling windows:

| Limit | Hard cap |
|---|---:|
| Minimum gap | 12 seconds between sends |
| Per rolling minute | 5 |
| Per rolling hour | 50 |
| Per rolling 24 hours | 100 |

These limits apply to **the whole app**, not per recipient or server instance. When reached, the registration endpoint returns **429**, and a new OTP is **not** generated or stored.

The limiter automatically creates one small MongoDB collection named `registration_email_limits` through the **already configured** `MONGODB_URI`. The document stores only sending timestamps, not email addresses or OTPs. Each reservation counts even if SMTP subsequently fails or times out; this avoids accidentally doubling sends when SMTP acceptance is uncertain. The existing MongoDB user must have normal read/write permissions to its database.

**Important:** These conservative limits are not a statement of your Hostinger plan's actual allowance. Confirm your SMTP provider plan's limits. High legitimate registration traffic can receive a 429 response when the shared cap is reached.

## Safe test

From the extracted project directory, with Node.js 20 or later:

```bash
node --test tests/email-policy.test.js
```

The 13 automated tests use mocked MongoDB and SMTP and do not send real email. They test 1,000 simultaneous requests, rolling caps, stale writes, disconnection, and the disabled email endpoints. The mock tests and syntax checks passed. **A real MongoDB/Hostinger staging end-to-end test was not run.**

## Deploy to Hostinger

1. Back up the currently running backend and its environment variables.
2. For a full deployment, upload `otli-server-registration-only-minimal.zip`; for an existing deployment, merge only the files from the changed-files ZIP into the same relative paths.
3. Keep your current `.env` values (SMTP, `MONGODB_URI`, JWT, ports, origins) unchanged. Do **not** upload passwords in ZIP files.
4. Keep the existing start command: `npm start` (runs `node server.js`).
5. Restart the Node.js app and verify `/` and `/health` before testing registration.
6. Verify booking status notifications from both the client and admin sites. Test a registration OTP with one authorized test address only.
7. If the website still responds with **503**, inspect Hostinger's Runtime Logs. The server startup, MongoDB connection, and CORS code have **not** been changed by this update; the 503 may have an unrelated cause.

**No system can guarantee that an SMTP provider will not suspend an account.** Invalid recipients, complaints, quota mismatches, compromised credentials, and suspicious signup behavior remain possible risks.
