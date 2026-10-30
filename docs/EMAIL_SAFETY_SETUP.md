# OTLI Express Email Safety — Installation, Operation and Limitations

## 1. What was changed

The existing SMTP transport in `config/mailer.js`, OTP and password reset routes, booking templates, booking notifier, authentication logic, and API URLs remain intact. All calls to `sendEmail()` now create a **MongoDB durable encrypted outbox record** and a **BullMQ job in Redis**. Email content and OTPs are encrypted at rest and not stored in BullMQ. SMTP is only invoked by the rate-limited worker.

Separate `transactional`, `marketing`, and `campaigns` queues share one provider-wide rate limiter and exclusive SMTP sender lease, preventing multiple web instances from bypassing provider limits. The API defaults to spawning workers; set `EMAIL_WORKER_ENABLED=false` on API nodes to run `npm run email:worker` separately.

**Required infrastructure:** MongoDB (already used) + persistent, private Redis >= 6. Ensure Redis is configured with append-only persistence (AOF), access controls, backups and predictable memory policies (do not evict BullMQ keys). Redis rate-counter loss is detected by a MongoDB-backed sentinel and globally PAUSES sending until an authorized review. Redis is a hard requirement; there is **no unsafe direct-SMTP fallback**.

## 2. Install and first-time migration

1. Back up your existing server and MongoDB before replacing the files.
2. `npm install` after extraction; this will fetch **bullmq ^5.81.5**, **ioredis ^5.9.3**, and **vitest ^4.0.0**, and regenerate `package-lock.json`. The package-lock supplied with the original zip remains present as a historical snapshot; **do not use `npm ci` until `npm install` has refreshed and committed the lockfile**. Package downloads were unavailable in the delivery environment.
3. Merge `.env.email.example` with your existing SMTP/Mongo/JWT configuration. Do not replace existing credentials. Set stable, independent `EMAIL_PAYLOAD_KEY` (32 cryptographically random bytes, base64) and `EMAIL_HMAC_SECRET` (>=32 cryptographically random characters). Never commit or log those values. A secret change requires a data migration: old suppression hashes and encrypted queued OTPs cannot be accessed with a new key. If a change is detected, workers pause automatically.
4. Configure Redis with persistence, authentication and a private network; check Redis availability with `redis-cli ping`. Use a **distinct** `EMAIL_REDIS_PREFIX` for each SMTP mailbox/provider account; all workers using the **same** SMTP mailbox must use the **same** prefix.
5. Run `npm run email:indexes` once against your existing MongoDB (additive indexes and schemas, no destructive edits). Existing users **do not receive marketing consent automatically**; missing preference fields are treated as opted out, and no mass migration is needed.
6. Run `npm run test:offline`, `npm run email:simulate`, `npm run email:dns`. For dependency-based Vitest run `npm test` after `npm install`. Use staging integration instructions below before live rollout.
7. Verify actual mailbox quota, recent rolling-24-hour usage, provider anti-abuse rules and SPF/DKIM/DMARC. Set `EMAIL_LIMIT_*` **below** the account's actual allowance, leaving room for manual/webmail messages. An unknown historical sending quota on first deployment is NOT reflected in Redis; avoid bulk sending until the rolling quota is known.
8. Deploy with `EMAIL_MARKETING_ENABLED=false` initially. Confirm OTP and booking notification functionality in a staging sandbox. Only enable marketing after proving consent, unsubscribe, domain authentication, provider approval and capacity.

Start a single-host deployment using `npm start`, which starts queue workers after Mongo and Redis connect. Or run `EMAIL_WORKER_ENABLED=false npm start` for the API plus `npm run email:worker` as a separate process. Restart gracefully (SIGTERM). With a dedicated worker, retain monitoring on the API. Shared Redis rate counters apply to both queues and across all machines using the same namespace.

## 3. Email types and existing endpoints

Existing URL paths stay unchanged:

- `POST /api/auth/client/register/request-otp` — OTP email, waits for SMTP **acceptance**. Job expires with OTP; stale OTP messages are discarded. Validation/resend rules remain.
- `POST /api/auth/client/register/resend-otp` — new OTP invalidates previous queued OTP. Existing resend timer retained.
- `POST /api/auth/forgot-password` — hashed OTP remains in existing User fields; email is queued and awaited.
- `POST /api/auth/email/test` — development-only and now **requires existing admin JWT** (`Authorization: Bearer ...`). Accepts via queue. In `EMAIL_DELIVERY_MODE=mock` it never uses SMTP.
- Booking status notifications — queued asynchronously; the existing client notification, booking email template, subject and booking UI remain unchanged. The system deduplicates identical booking state/event keys.

OTP endpoints only return the existing success response after SMTP acceptance. If the provider is slow or a queue is full, the API returns a 503 instead of falsely saying it was sent; a queued OTP may still arrive later (until its short expiration). Do not automatically issue duplicate OTP requests on a 503; retain the resend cooldown. OTPs will not be delivered if they expire or were superseded.

## 4. Consent, campaigns and unsubscribe

An authenticated client can explicitly opt in/out using:

- `GET /api/client/email-preferences` — check current marketing consent.
- `PATCH /api/client/email-preferences` with `{ "marketingEnabled": true }` or `false` — record user decision. Opt-out takes effect for pending emails too. Previously hard-bounced/complaining recipients cannot re-subscribe by this endpoint.

Only **verified/active registered clients** with `marketingEmailConsent.enabled===true` are eligible for promotional campaigns. No arbitrary recipient list from the browser is accepted. This implementation intentionally does **not** treat acceptance of the portal Terms/Privacy Policy as marketing consent. For stricter provider/local rules, add double opt-in collection in your customer-facing frontend.

Super admin creates a campaign (must use existing JWT) via:

```
POST /api/admin/email/campaigns
{
  "campaignKey": "customer-news-2026-11",
  "subject": "A customer-approved update",
  "html": "<p>Update text...</p>",
  "text": "Update text...",
  "maxRecipients": 10000
}
```

`EMAIL_MARKETING_ENABLED=true` and a public HTTPS `EMAIL_PUBLIC_BASE_URL` are required. This returns HTTP 202 and a campaign ID immediately. A single global campaign ingester scans eligible users in batches (default 200), checks current consent/suppression, and writes independently idempotent email jobs. A critical marketing incident pauses marketing and campaign ingestion but not transactional OTPs. Provider-global suspension pauses **both**.

Marketing email includes a visible unsubscribe link and RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers. `GET /api/email/unsubscribe?token=...` shows a confirmation page; it **does not** unsubscribe on GET, preventing automated link-scanner opt-outs. `POST /api/email/unsubscribe` handles one-click unsubscribe using query token or HTML-form body token. Tokens are signed with HMAC and contain only the message ID. Hard bounces and complaints suppress all categories; unsubscribes suppress marketing. Keep the HMAC key stable for historical links.

## 5. Monitoring / incident controls (administrator protected)

- `GET /api/admin/email/monitor` — status Healthy/Warning/Paused, total queued, accepted (not delivered), confirmed delivered (if provider events available), failed, bounced, complained, suppressed, uncertain, rolling rate counters, job queue health, open incidents.
- `GET /api/admin/email/incidents` — super admin incident history.
- `GET /api/admin/email/campaigns` — super admin campaign progress.
- `POST /api/admin/email/pause` `{ "category": "marketing" }` or `transactional`/`all` — super admin manual pause.
- `POST /api/admin/email/resume` `{ "category": "all", "providerClearanceConfirmed": true, "recoveryNote": "Provider confirmed reset; quota reviewed" }` — super admin only. Requires an appropriate attestation when provider suspension/auth errors or Redis quota loss occurred. **Never resume while provider has the account suspended.**
- `POST /api/admin/email/suppress` `{ "email": "bad@example.com", "scope": "all" }` — super admin suppression.
- `POST /api/admin/email/provider-events` — super admin upload of **verified** provider events only.
- `POST /api/admin/email/reconcile` — repair jobs stranded between Mongo outbox insert and Redis enqueue, super admin.

Pauses are stored in Redis and as MongoDB `EmailIncident` records. Critical events also create in-app notifications for active superadmins and emit socket events when available. Workers consult pause flags immediately before SMTP; an in-progress SMTP transaction cannot be recalled.

For automated provider events, `POST /api/email/webhook` requires the exact raw JSON body signed using `HMAC-SHA256(EMAIL_WEBHOOK_SECRET)` in `x-email-signature: sha256=<hex>`. Supported normalized JSON schema:

```
{ "eventId": "provider-unique-123", "type": "delivered", "messageId": "smtp-id" }
```

`type` supports `delivered`, `hard_bounce`, `complaint`, `unsubscribed`, `warning`, `suspended`. **This is a generic authenticated adapter; Hostinger SMTP may not provide native webhook events.** A provider-specific adapter or verified provider report must translate official events to this schema. Until that integration exists, most messages show **accepted**, not confirmed delivered. Never manufacture delivered events or assume acceptance equals inbox placement.

## 6. Rate limits and suspension controls

Global per-provider limit defaults: **1/sec, 5/min, 50/hour, 100 per rolling 24 hours**, all independently enforced with Redis TIME and atomic Lua across both queues and all app instances. Every attempted send consumes a slot, even if SMTP rejects it. The default `EMAIL_MARKETING_PROVIDER_FRACTION=0.8` limits marketing to at most 80% of the shared minute/hour/day budgets, reserving capacity for OTPs and booking notices. Per-recipient marketing limits default to **1/24 hours** and **2/7 days**; stored atomic reservations are conservative on failure. Worker concurrency defaults to 1 with a cross-worker exclusive SMTP lease.

Error handling:

- Provider 421 / 429 / quota or throttle 4xx: global cooldown and delayed retry; repeated throttling pauses all queues.
- Definitive temporary 4xx / pre-connect failures: exponential backoff + jitter, 5 tries by default.
- Hard bounce/complaint: durable suppression, pending future sends skipped.
- Suspension/authentication errors: **global pause**, persistent incident, super-admin recovery + provider clearance.
- Socket reset/timeout or unknown SMTP outcome: mark **uncertain**, NO automatic resend. This prevents duplicate deliveries if the provider accepted the message before the connection failed. An operator must investigate and initiate a **new authorized event** if necessary.
- Stalled/recovered job with a pre-existing `sending` marker: mark **uncertain**; never blindly replay.
- Redis unavailable: fail closed; no direct SMTP fallback. Mongo outbox is retained for reconciliation.
- Redis quota counters lost (e.g., persistence failure): pause immediately; reconcile 24-hour quota history and provider status before authorized reset.

Safety rates: an hourly volume increase of 4x triggers a warning and 8x a marketing pause (once at least 100 sends exist in the latest hour); configure these to fit the account. Initial warning/critical complaint thresholds 0.1%/0.3%, hard bounce 2%/5%, failed 5%/10%, with sample minimum 100. Provider-specific policies may differ; refine these in config. Google's published Gmail sender guidance advises remaining below 0.1% user-reported spam and avoiding 0.3%+. All rates are based on **available** recorded events; lack of a complaint feed is not proof of a low complaint rate.

## 7. DNS authentication

Set `MAIL_FROM` using your authorized domain and confirm the SMTP envelope sender (`SMTP_USER`) or DKIM `d=` aligns with RFC5322 From under DMARC. The DNS helper:

```
npm run email:dns
```

checks for an SPF TXT record at the sending domain, a DMARC TXT record at `_dmarc.<domain>`, and (if `EMAIL_DKIM_SELECTOR` is configured) DKIM TXT. An absent selector cannot prove there is no DKIM (providers may publish CNAMEs). Make sure exactly one valid SPF record exists and includes all authorized senders, the provider signs DKIM, DMARC publishes a policy (initially `p=none` while validating, stronger when ready), and SMTP uses TLS. Then check authentication results in the headers of **an explicitly authorized small test message**. The helper does not automatically edit DNS and does not claim authentication is verified.

## 8. Safe tests (NO real bulk email)

```
npm run test:offline         # Node built-in policy tests — zero dependencies/SMTP
npm run email:simulate      # 10, 100, 1k, 10k, 50k virtual-time recipients
npm test                    # Vitest tests (requires npm install)
```

Simulation reports are created in `reports/email-risk-assessment.{md,json}`. The virtual script runs with Node only and never opens SMTP, Redis or MongoDB. It simulates bursts, rate windows, bounces, complaints, 421 throttling, 451 temporary errors, deduplication, crash/restart and suspension; its numbers are **not proof** that actual BullMQ/Redis integration behaves identically.

To test against staging infrastructure while **forcing** mock SMTP transport:

```
# Set EMAIL_TEST_MONGODB_URI to a disposable test MongoDB cluster URI.
# Set REDIS_URL to an isolated staging Redis instance.
EMAIL_RUN_INTEGRATION=true npm run test:integration
npm run email:staging-load -- 1000
npm run email:staging-load -- 10000
npm run email:staging-load -- 50000
```

The staging load command overwrites NODE_ENV to `test`, EMAIL_DELIVERY_MODE to `mock`, and uses a fresh isolated `otli_email_test_<random>` database + Redis prefix each time; it does not touch SMTP. It measures queue ingestion/job states plus Redis rate budget and memory. The original environment where this code was prepared did not have npm package downloads, Redis or a staging MongoDB, so these **integration tests have not been run**. Do not treat the app as production-verified until your team executes them and records results.

## 9. Remaining risks and deployment recommendation

1. **Mailbox suitability:** Even 50k **legitimate** opted-in recipients would need over 600 days at the default marketing reserve (at most 80/day of a 100/day account). Hostinger Business Starter publishes 1,000/day, Standard/Premium 3,000/day, but exact account entitlements may vary. Use a provider and authorized marketing/bulk plan suitable for the intended volume; do not attempt provider-limit circumvention.
2. **Missing provider bounce/complaint data:** Without an official event feed, automatic suppression is limited to synchronous SMTP errors, authenticated imported events and user unsubscribes. Do not infer delivery or reputation from SMTP acceptance alone.
3. **Exactly-once delivery is not mathematically guaranteed through SMTP:** The system chooses quarantine over automatic retries for ambiguous delivery outcomes; admins must review them. Monitor queue age, OTP latency and retention.
4. **Marketing consent and laws:** Collect auditable category-specific opt-ins and verify the Philippine Data Privacy Act and rules applicable to all recipient jurisdictions; include transparent purposes and unsubscribe mechanisms.
5. **External DNS/hosting/monitoring:** Verify domain authentication, actual sending identities and provider sending quota manually. Keep an independent incident-alerting path (e.g. external monitoring) if database/socket alerts are down.
6. **Operational infrastructure:** Protect Redis from eviction and data loss; monitor Mongo availability; test encrypted key backups, code deployments, retry behavior, and signed provider webhooks in staging.
7. **Code audit pending:** Review the final patch against existing application business requirements, test OTP flows end-to-end, and approve a gradual production rollout. No code-only simulation can guarantee an email provider will never suspend an account.

**Release gate:** Do NOT enable real bulk marketing until Redis/Mongo integration tests, consent collection, provider authorization, DNS checks and low-volume production smoke tests all pass.
