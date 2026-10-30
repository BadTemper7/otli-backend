> Historical setup note from the earlier patch. For this latest package, also read **API_TIMEOUT_DIAGNOSTICS.md** (which adds shared API diagnostics and updates `server.js`).

# OTLI registration upload and OTP timeout fix

This patch is based on **otli-server-registration-only-minimal.zip** (the previous registration-only email build derived from the newly uploaded `otli-server.zip`). It does **not** enable any additional email, add Redis/dependencies, alter `server.js`, change API paths, or require new environment variables.

## Why `timeout of 30000ms exceeded` appears

The browser's Axios client likely has `timeout: 30000`, while the single multipart `POST /api/auth/client/register/request-otp` does all of the following before responding:

1. Receives the full multipart body (the uploaded files).
2. Validates the registration and checks MongoDB.
3. Saves all submitted documents to the local documents directory.
4. Hashes the password, creates the pending registration and OTP.
5. Connects to Hostinger SMTP and waits for provider acceptance.

A large upload or slow provider can easily take more than 30 seconds. **The server update alone cannot change the timeout configured in the frontend.**

## IMPORTANT: Change the client-side registration request

Find the existing **client frontend** call to `/client/register/request-otp` (often in a registration form or an Axios API service). Keep the current URL and form fields; add a request-specific timeout of 120 seconds:

```jsx
// Use your existing Axios instance and existing request URL.
const result = await api.post(existingRegistrationOtpUrl, formData, {
  timeout: 120000, // 2 minutes for multipart upload + SMTP
});
```

If you use `axios.post(...)` rather than an Axios instance, the same `timeout: 120000` option applies. Do **not** set this as a global timeout unless needed. If you already pass options, merge `timeout` into the existing third argument. Let the browser generate the multipart boundary rather than manually setting an incomplete Content-Type header.

**Don't automatically retry this POST when the client times out.** The server may have accepted the upload and delivered the OTP after the browser disconnected. Check email and attempt the existing OTP/resend flow as appropriate. The server keeps a 60-second resend cooldown.

If upload still takes too long, reduce document sizes; this project currently allows up to 10 MB per file. If the hosting reverse proxy itself enforces a ~30-second limit, a 120-second Axios setting will *not* override it; that situation requires a separate upload endpoint or Hostinger configuration change after inspecting logs.

## Backend improvements in this patch

- Saves multiple uploaded documents concurrently rather than serially; removes partially written files if any write fails.
- Uses shorter SMTP inactivity limits: 8 s connection, 8 s greeting, 12 s socket. These are **not** an overall completion deadline.
- If SMTP fails after the registration was saved, returns HTTP **503** with `code: REGISTRATION_OTP_DELIVERY_UNCONFIRMED`, a safe user message and `Retry-After: 60`. It does **not** automatically retry a potentially accepted email.
- Logs total time and stage timings for slow or failed registration requests; logs no email addresses, OTPs, passwords or documents.
- Keeps transactional registration-only sending, MongoDB's shared 1/12 s, 5/min, 50/hour, 100/day limits, existing booking in-app notifications, disabled other email endpoints, existing server startup and existing CORS behavior.

## What Hostinger logs will show

For slow/failed registration requests, inspect the Hostinger **Runtime Logs**:

```
[registration] request-otp status=200 totalMs=18250 stages={"uploadMs":12500,"userLookupMs":55,"pendingLookupMs":46,"limitMs":35,"saveFilesMs":50,"hashPasswordMs":82,"savePendingMs":45,"smtpMs":5437}
```

- `uploadMs` high: slow client upload / large file / network.
- `smtpMs` high: Hostinger SMTP connection or provider response.
- `userLookupMs`, `pendingLookupMs`, `limitMs`, `savePendingMs` high: MongoDB latency.
- `saveFilesMs` high: Hostinger file storage speed.
- `browser/proxy disconnected after ...ms`: the client or proxy closed before receiving a response. Check Axios/host proxy timeouts.

The numbers above are **illustrative**, not measured production results.

## Install and test

1. Back up your existing backend and use the ZIP or apply only the affected files.
2. Keep the same existing `.env`. No additional credentials, Redis or npm packages are needed.
3. Update the **frontend registration Axios call** as shown above.
4. Restart Node.js in Hostinger, test one registration with small documents, and inspect Runtime Logs.
5. Run offline tests locally or on staging:

```bash
npm run test:registration
npm run test:email
```

These are mocked/offline tests. They do not test your live Hostinger SMTP, MongoDB connection, frontend upload duration or proxy timeout. If the server still returns 503 at startup, that's a separate hosting/runtime issue.
