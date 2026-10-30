# OneTrue / OTLI API - Localhost CORS Test Guide

This package builds on `otli-server-login-diagnostics.zip` with a minimal CORS-only change.
It preserves the registration-only email restrictions, existing routes, MongoDB logic,
authentication, and Socket.IO event handling.

## How it works

- When `NODE_ENV=development` or `NODE_ENV=test`: Express and Socket.IO permit browser requests from any Origin, including any localhost/127.0.0.1 port. Credentials are supported with **Origin reflection**, never `*`.
- When `NODE_ENV=production` (or unset): only `https://onetrue.ph`, `https://admin.onetrue.ph`, and explicitly configured origins in the existing `CLIENT_ORIGINS`, `CORS_ORIGINS`, or `SOCKET_ALLOWED_ORIGINS` settings are allowed.
- Your previously supplied `CLIENT_ORIGINS` already includes `http://localhost:5173` and `http://localhost:5174`. Therefore, these two local frontend origins are also permitted when accessing the production API.
- Unknown production origins remain blocked. Unauthenticated requests without an Origin header are not blocked by CORS; your existing endpoint authentication still applies.

## Test with local Express and React

1. Set the **existing** `NODE_ENV=development` in your local `.env` (do not change Hostinger's production setting). Verify `MONGODB_URI` points to an authorized development database before testing mutations or registration.
2. Run `npm install`, then `npm run dev` (or `npm start`), provided the database and dependencies are available.
3. For a React development client, configure its **existing** Vite API URL to `http://localhost:3000/api` and its socket URL to `http://localhost:3000`, then restart Vite. If using the deployed backend instead, retain `https://api.onetrue.ph/api` and check that the deployed `CLIENT_ORIGINS` includes your exact local frontend Origin.
4. Browse `http://localhost:3000/api/test` to confirm the backend is listening.
5. Verify an HTTP preflight (replace URL with the deployed API when needed):

```bash
curl -i -X OPTIONS http://localhost:3000/api/auth/login \
  -H 'Origin: http://localhost:5173' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,authorization'
```

Expected: `204` with `Access-Control-Allow-Origin: http://localhost:5173` and `Access-Control-Allow-Credentials: true`.

## Offline tests

```bash
node --test tests/*.test.js
```

CORS is a browser security check, not a server connectivity feature. A 503 or 30-second timeout, DNS/SSL errors, blocked MongoDB connection, or incorrect API URL cannot be fixed by CORS settings. If your live API is down, check `https://api.onetrue.ph/api/test` and Hostinger runtime logs separately.

No extra npm packages, Redis, or new environment variables are required.
