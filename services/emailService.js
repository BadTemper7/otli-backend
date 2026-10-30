"use strict";
const crypto = require("node:crypto");
const { Worker } = require("bullmq");
const mongoose = require("mongoose");
const { sendNow } = require("../config/mailer.js");
const { policy, normalizeEmail, classifyProviderError, digest } = require("./emailPolicy.js");
const { encrypt, decrypt, addressHash, eventHash, unsubscribeToken, verifyUnsubscribeToken, key, secret } = require("./emailCrypto.js");
const { redis, queue, newWorker } = require("./emailQueue.js");
const limiter = require("./emailRateLimiter.js");
const monitoring = require("./emailMonitoring.js");
const Outbound = require("../models/OutboundEmail.js");
const Suppression = require("../models/EmailSuppression.js");
const Campaign = require("../models/EmailCampaign.js");
const ProviderEvent = require("../models/EmailProviderEvent.js");
const SafetyState = require("../models/EmailSafetyState.js");
const User = require("../models/User.js").default;
const Pending = require("../models/PendingClient.js").default;
const TERMINAL = new Set(["accepted", "delivered", "bounced", "complained", "failed", "suppressed", "uncertain", "expired"]);
const SLEEP = ms => new Promise(resolve => setTimeout(resolve, ms));
let started = false;
let ticker = null;
let sendWorker, campaignWorker;
let outboxCursor = null;
const emailJobOpts = () => ({ attempts: policy().retries, backoff: { type: "custom" }, removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 604800, count: 10000 } });
function publicBaseUrl() {
  const url = String(process.env.EMAIL_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(url)) throw new Error("EMAIL_PUBLIC_BASE_URL must be a public HTTPS origin for marketing unsubscribe");
  return url;
}
async function isSuppressed(hash, category) {
  return Boolean(await Suppression.exists({ addressHash: hash, scope: { $in: category === "marketing" ? ["all", "marketing"] : ["all"] } }));
}
async function suppress(hash, scope, reason) {
  await Suppression.updateOne({ addressHash: hash, scope }, { $set: { reason } }, { upsert: true });
}
async function hasMarketingConsent(to) {
  return Boolean(await User.exists({ email: to, userType: "client", status: { $in: ["active", "verified"] }, "marketingEmailConsent.enabled": true }));
}
function safeResult(doc, created = false) {
  return { id: String(doc._id), created, status: doc.status, queued: doc.status === "queued", messageId: doc.providerMessageId || null };
}
async function enqueueEmail({ to, subject, html, text, category = "transactional", eventType = "notification", eventKey, expiresAt = null, otpContext = null, campaign = null, awaitAcceptance = true } = {}) {
  const address = normalizeEmail(to);
  if (!address || !subject || (!html && !text)) throw Object.assign(new Error("A valid recipient, subject and content are required"), { status: 400 });
  if (!["marketing", "transactional"].includes(category)) throw new Error("Invalid email category");
  if (String(subject).length > 250 || String(html || "").length > 250000 || String(text || "").length > 250000) throw new Error("Email content exceeds configured size limits");
  // Do not queue promotional mail without explicit, auditable consent.
  if (category === "marketing") {
    if (!policy().marketingEnabled) throw Object.assign(new Error("Marketing email is disabled by configuration"), { status: 503 });
    if (!eventKey) throw Object.assign(new Error("Promotional emails require an event idempotency key"), { status: 400 });
    publicBaseUrl();
    if (!(await hasMarketingConsent(address))) return { status: "suppressed", created: false, reason: "no_marketing_consent" };
    if (await limiter.paused("marketing")) throw Object.assign(new Error("Marketing queue is paused"), { status: 503 });
  }
  const hash = addressHash(address);
  if (await isSuppressed(hash, category)) return { status: "suppressed", created: false, reason: "suppression_list" };
  const dedupe = eventHash(address, String(eventKey || digest(`${subject}:${html || text}`, secret())));
  let doc, created = false;
  try {
    doc = await Outbound.create({ eventKey: dedupe, addressHash: hash, to: address, payload: encrypt({ subject, html, text }), category, eventType, expiresAt, otpContext, campaign });
    created = true;
  } catch (error) {
    if (error.code !== 11000) throw error;
    doc = await Outbound.findOne({ eventKey: dedupe });
    if (!doc) throw error;
  }
  if (doc.status === "queued") {
    // Job stores only the Mongo id, never OTP, address, subject, or email body.
    await queue(category).add("deliver", { id: String(doc._id) }, { ...emailJobOpts(), jobId: String(doc._id), priority: category === "transactional" ? 1 : 10 });
  }
  if (!awaitAcceptance) return safeResult(doc, created);
  return await waitForAcceptance(doc._id, policy().acceptanceTimeoutMs);
}
async function waitForAcceptance(id, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const doc = await Outbound.findById(id).select("status reason providerMessageId").lean();
    if (!doc) throw new Error("Queued email was not found");
    if (TERMINAL.has(doc.status)) {
      if (["accepted", "delivered"].includes(doc.status)) return safeResult(doc);
      throw Object.assign(new Error(`Email could not be sent (${doc.status}${doc.reason ? `: ${doc.reason}` : ""})`), { status: 503 });
    }
    await SLEEP(250);
  }
  throw Object.assign(new Error("Email is queued but has not yet been accepted by the provider; do not resend immediately"), { status: 503, code: "EMAIL_STILL_QUEUED" });
}
async function otpIsCurrent(doc) {
  const ctx = doc.otpContext;
  if (!ctx) return true;
  if (!mongoose.isValidObjectId(ctx.id)) return false;
  if (ctx.kind === "registration") {
    const pending = await Pending.findById(ctx.id).select("+otpHash").lean();
    return Boolean(pending && pending.otpHash === ctx.hash && pending.otpExpiresAt && new Date(pending.otpExpiresAt) > new Date());
  }
  if (ctx.kind === "password_reset") {
    const user = await User.findById(ctx.id).select("+passwordResetOtpHash").lean();
    return Boolean(user && user.passwordResetOtpHash === ctx.hash && user.passwordResetExpiresAt && new Date(user.passwordResetExpiresAt) > new Date());
  }
  return false;
}
async function finalize(id, status, reason = "") {
  return Outbound.updateOne({ _id: id, status: { $in: ["queued", "sending"] } }, { $set: { status, reason, payload: null } });
}
async function requeue(doc, reason) { await Outbound.updateOne({ _id: doc._id, status: "sending" }, { $set: { status: "queued", reason } }); }
function marketingHeaders(id, payload) {
  const url = `${publicBaseUrl()}/api/email/unsubscribe?token=${encodeURIComponent(unsubscribeToken(id))}`;
  return {
    subject: payload.subject,
    html: payload.html ? `${payload.html}<p style="font-size:12px;color:#64748b">To stop promotional email, <a href="${url}">unsubscribe here</a>.</p>` : undefined,
    text: payload.text ? `${payload.text}\n\nUnsubscribe: ${url}` : undefined,
    headers: { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}
async function processDelivery(job, worker) {
  const doc = await Outbound.findById(job.data.id).select("+payload +otpContext");
  if (!doc || TERMINAL.has(doc.status)) return { status: doc?.status || "missing" };
  if (doc.status === "sending") {
    // Crash, Redis stall or disconnect while SMTP may have been accepting DATA.
    // Never replay an ambiguous send.
    await finalize(doc._id, "uncertain", "worker_recovered_after_inflight_send");
    await monitoring.warning(doc.category, "uncertain_delivery_requires_manual_review");
    return { status: "uncertain" };
  }
  if (doc.expiresAt && doc.expiresAt < new Date()) { await finalize(doc._id, "expired", "expired_before_sending"); return { status: "expired" }; }
  if (!normalizeEmail(doc.to) || await isSuppressed(doc.addressHash, doc.category)) { await finalize(doc._id, "suppressed", "invalid_or_suppressed"); return { status: "suppressed" }; }
  if (doc.category === "marketing" && !policy().marketingEnabled) { await worker.rateLimit(60000); throw Worker.RateLimitError(); }
  if (doc.category === "marketing" && !(await hasMarketingConsent(doc.to))) { await finalize(doc._id, "suppressed", "marketing_consent_missing"); return { status: "suppressed" }; }
  if (!(await otpIsCurrent(doc))) { await finalize(doc._id, "expired", "otp_superseded_or_expired"); return { status: "expired" }; }
  if (await limiter.paused(doc.category)) { await worker.rateLimit(60000); throw Worker.RateLimitError(); }
  // Frequency reservations are atomic across all instances; conservative if a send later fails.
  if (doc.category === "marketing" && !(await limiter.reserveMarketing(doc.addressHash, String(doc._id)))) {
    await finalize(doc._id, "suppressed", "marketing_frequency_cap"); return { status: "suppressed" };
  }
  const owner = crypto.randomBytes(16).toString("hex");
  if (!(await limiter.leaseSender(owner))) { await worker.rateLimit(1000); throw Worker.RateLimitError(); }
  try {
    const slot = await limiter.reserveGlobal(`${doc._id}:${job.attemptsMade}:${owner}`, doc.category);
    if (slot.quotaStateLost) {
      await monitoring.pauseQueues("all", "redis_rate_counters_lost_requires_provider_quota_reconciliation", "limiter");
      await worker.rateLimit(60000); throw Worker.RateLimitError();
    }
    if (!slot.allowed) { await worker.rateLimit(slot.delayMs); throw Worker.RateLimitError(); }
    // Recheck after obtaining shared quota and the exclusive sender lease.
    if (await limiter.paused(doc.category)) { await worker.rateLimit(60000); throw Worker.RateLimitError(); }
    // Final consent/suppression check just before passing the recipient to SMTP.
    if (await isSuppressed(doc.addressHash, doc.category) || (doc.category === "marketing" && !(await hasMarketingConsent(doc.to)))) {
      await finalize(doc._id, "suppressed", "suppressed_before_smtp");
      return { status: "suppressed" };
    }
    const claimed = await Outbound.updateOne({ _id: doc._id, status: "queued" }, { $set: { status: "sending", reason: "" }, $inc: { attempts: 1 } });
    if (!claimed.modifiedCount) return { status: "claimed_elsewhere" };
    await monitoring.recordMetric("attempt", String(doc._id));
    const payload = decrypt(doc.payload);
    try {
      const prepared = doc.category === "marketing" ? marketingHeaders(doc._id, payload) : payload;
      const info = await sendNow({ to: doc.to, ...prepared });
      // Accepted means SMTP accepted responsibility, NOT inbox delivery.
      await Outbound.updateOne({ _id: doc._id, status: "sending" }, { $set: { status: "accepted", providerMessageId: info.messageId || "", acceptedAt: new Date(), payload: null } });
      await monitoring.recordMetric("accepted", String(doc._id));
      if (parseInt(String(doc._id).slice(-4), 16) % 100 === 0) await monitoring.checkRisk();
      return { status: "accepted" };
    } catch (error) {
      const kind = classifyProviderError(error);
      if (kind === "suspended" || kind === "auth") {
        await requeue(doc, kind);
        await monitoring.recordMetric(kind === "auth" ? "auth" : "failed", String(doc._id));
        await monitoring.pauseQueues("all", kind === "suspended" ? "provider_suspension_reported" : "smtp_authentication_failure");
        await worker.rateLimit(60000);
        throw Worker.RateLimitError();
      }
      if (kind === "throttle") {
        await requeue(doc, "provider_throttled");
        await monitoring.recordMetric("throttle", String(doc._id));
        await limiter.setCooldown(policy().cooldownMs);
        await monitoring.checkRisk();
        await worker.rateLimit(policy().cooldownMs);
        throw Worker.RateLimitError();
      }
      if (kind === "hard_bounce") {
        await suppress(doc.addressHash, "all", "hard_bounce");
        await finalize(doc._id, "bounced", "smtp_hard_bounce");
        await monitoring.recordMetric("bounce", String(doc._id));
        await monitoring.checkRisk();
        return { status: "bounced" };
      }
      if (kind === "permanent") {
        await finalize(doc._id, "failed", "smtp_permanent_rejection");
        await monitoring.recordMetric("failed", String(doc._id));
        await monitoring.checkRisk();
        return { status: "failed" };
      }
      if (kind === "uncertain") {
        await finalize(doc._id, "uncertain", "ambiguous_smtp_outcome_no_automatic_retry");
        await monitoring.warning(doc.category, "uncertain_delivery_requires_manual_review");
        return { status: "uncertain" };
      }
      // A definitive SMTP 4xx or pre-connect error is safe to retry with jitter.
      if (job.attemptsMade + 1 >= policy().retries) {
        await finalize(doc._id, "failed", "temporary_failures_exhausted");
        await monitoring.recordMetric("failed", String(doc._id));
        await monitoring.checkRisk();
        return { status: "failed" };
      }
      await requeue(doc, "temporary_smtp_failure");
      throw new Error("SMTP_TEMPORARY_FAILURE");
    }
  } finally {
    // Never mask the previous error with a Redis cleanup failure.
    await limiter.releaseSender(owner).catch(() => {});
  }
}
async function enqueueCampaignJob(campaign) {
  return queue("campaigns").add("ingest", { id: String(campaign._id) }, { jobId: `${campaign._id}-${campaign.cursor || "start"}`, attempts: policy().retries, backoff: { type: "custom" }, removeOnComplete: { age: 3600 } });
}
async function createCampaign({ campaignKey, subject, html, text, createdBy, maxRecipients }) {
  if (!policy().marketingEnabled) throw Object.assign(new Error("Marketing email is disabled"), { status: 503 });
  if (await limiter.paused("marketing")) throw Object.assign(new Error("Marketing queue is paused"), { status: 503 });
  publicBaseUrl();
  if (!/^[a-zA-Z0-9_-]{8,96}$/.test(campaignKey || "")) throw Object.assign(new Error("campaignKey must be 8-96 characters (letters, digits, underscore, hyphen)"), { status: 400 });
  if (!subject || (!html && !text) || String(subject).length > 250 || String(html || "").length > 250000 || String(text || "").length > 250000) throw Object.assign(new Error("Invalid campaign content"), { status: 400 });
  const max = Number(maxRecipients || policy().bulkMax);
  if (!Number.isSafeInteger(max) || max <= 0 || max > policy().bulkMax) throw Object.assign(new Error("Invalid maxRecipients"), { status: 400 });
  let campaign;
  try { campaign = await Campaign.create({ campaignKey, createdBy, payload: encrypt({ subject, html, text }), maxRecipients: max }); }
  catch (e) { if (e.code !== 11000) throw e; campaign = await Campaign.findOne({ campaignKey }); }
  if (campaign.state !== "completed") await enqueueCampaignJob(campaign);
  return { id: String(campaign._id), campaignKey: campaign.campaignKey, state: campaign.state, enqueued: campaign.enqueued };
}
async function processCampaign(job, worker) {
  if (await limiter.paused("marketing") || !policy().marketingEnabled) { await worker.rateLimit(60000); throw Worker.RateLimitError(); }
  const campaign = await Campaign.findById(job.data.id).select("+payload");
  if (!campaign || campaign.state === "completed") return;
  const remaining = campaign.maxRecipients - campaign.enqueued;
  if (remaining <= 0) { campaign.state = "completed"; await campaign.save(); return; }
  const query = { userType: "client", status: { $in: ["active", "verified"] }, "marketingEmailConsent.enabled": true };
  if (campaign.cursor) query._id = { $gt: campaign.cursor };
  const users = await User.find(query).sort({ _id: 1 }).limit(Math.min(policy().batchSize, remaining)).select("email").lean();
  if (users.length === 0) { campaign.state = "completed"; await campaign.save(); return; }
  const { subject, html, text } = decrypt(campaign.payload);
  for (const user of users) {
    if (await limiter.paused("marketing")) { await worker.rateLimit(60000); throw Worker.RateLimitError(); }
    const result = await enqueueEmail({ to: user.email, subject, html, text, category: "marketing", eventType: "campaign", eventKey: `campaign:${campaign._id}`, campaign: campaign._id, awaitAcceptance: false });
    if (result.created) campaign.enqueued += 1;
    if (result.status === "suppressed") campaign.skipped += 1;
    campaign.cursor = user._id;
  }
  campaign.state = "ingesting";
  await campaign.save();
  await enqueueCampaignJob(campaign);
}
async function reconcileOutbox() {
  // Recovery for DB-created jobs where Redis was temporarily disconnected.
  const query = { status: "queued" };
  if (outboxCursor) query._id = { $gt: outboxCursor };
  let docs = await Outbound.find(query).sort({ _id: 1 }).limit(300).select("category expiresAt");
  if (!docs.length && outboxCursor) { outboxCursor = null; docs = await Outbound.find({ status: "queued" }).sort({ _id: 1 }).limit(300).select("category expiresAt"); }
  for (const d of docs) {
    if (d.expiresAt && d.expiresAt < new Date()) { await finalize(d._id, "expired", "expired_during_queue_recovery"); continue; }
    const q = queue(d.category);
    const existing = await q.getJob(String(d._id));
    if (existing) {
      const state = await existing.getState();
      if (state === "completed") { await finalize(d._id, "uncertain", "inconsistent_completed_job_manual_review"); continue; }
      if (state === "failed" && !(await limiter.paused(d.category))) await existing.retry();
      continue;
    }
    if (!existing) await q.add("deliver", { id: String(d._id) }, { ...emailJobOpts(), jobId: String(d._id), priority: d.category === "transactional" ? 1 : 10 });
  }
  if (docs.length) outboxCursor = docs[docs.length - 1]._id;
  const campaigns = await Campaign.find({ state: { $in: ["queued", "ingesting"] } }).limit(20).select("cursor");
  for (const campaign of campaigns) {
    const existing = await queue("campaigns").getJob(`${campaign._id}-${campaign.cursor || "start"}`);
    if (!existing) await enqueueCampaignJob(campaign);
  }
}
// Detect loss of Redis quota/frequency history. A Redis restart without persistence
// must not reset provider quotas and cause a second burst in the same 24 hours.
async function ensureRedisQuotaState() {
  const fingerprint = value => crypto.createHash("sha256").update(value).digest("hex");
  const hmacFingerprint = fingerprint(secret());
  const payloadFingerprint = fingerprint(key());
  const guarded = await SafetyState.findOne({ key: "cryptographic-identity-guard" });
  if (guarded && (guarded.hmacFingerprint !== hmacFingerprint || guarded.payloadFingerprint !== payloadFingerprint)) {
    await monitoring.pauseQueues("all", "crypto_key_changed_restore_original_or_migrate_suppression", "startup");
    return false;
  }
  if (!guarded) {
    try { await SafetyState.create({ key: "cryptographic-identity-guard", hmacFingerprint, payloadFingerprint }); }
    catch (error) { if (error.code !== 11000) throw error; }
  }
  const id = digest(`${process.env.SMTP_HOST || ""}|${process.env.SMTP_USER || ""}`, secret());
  const sentinelKey = limiter.k("quota-sentinel");
  const [sentinel, known] = await Promise.all([redis().get(sentinelKey), SafetyState.findOne({ key: id })]);
  if (known && sentinel !== id) {
    await monitoring.pauseQueues("all", "redis_rate_counters_lost_requires_provider_quota_reconciliation", "startup");
    return false;
  }
  if (sentinel && sentinel !== id) {
    await monitoring.pauseQueues("all", "sender_identity_changed_requires_quota_review", "startup");
    return false;
  }
  if (!sentinel) await redis().set(sentinelKey, id, "NX");
  await SafetyState.updateOne({ key: id }, { $setOnInsert: { key: id } }, { upsert: true });
  return true;
}
async function startWorkers() {
  if (started) return;
  // Startup refuses to use a live SMTP transport without shared Redis and payload encryption.
  key(); secret(); policy();
  await redis().ping();
  await ensureRedisQuotaState();
  // One campaign ingester worldwide, even when many Express instances run workers.
  await queue("campaigns").setGlobalConcurrency(1);
  await monitoring.ensureIncidentPauses();
  sendWorker = {
    transactional: newWorker("transactional", async job => processDelivery(job, sendWorker.transactional)),
    marketing: newWorker("marketing", async job => processDelivery(job, sendWorker.marketing)),
  };
  campaignWorker = newWorker("campaigns", async job => processCampaign(job, campaignWorker));
  await reconcileOutbox();
  ticker = setInterval(() => reconcileOutbox().catch(() => {}), 60000);
  ticker.unref?.();
  started = true;
}
async function stopWorkers() { if (ticker) clearInterval(ticker); ticker = null; }
async function recordProviderEvent({ eventId, type, messageId }) {
  if (!/^[a-zA-Z0-9:_-]{4,200}$/.test(String(eventId || ""))) throw Object.assign(new Error("Invalid provider event ID"), { status: 400 });
  if (!["delivered", "hard_bounce", "complaint", "unsubscribed", "suspended", "warning"].includes(type)) throw Object.assign(new Error("Invalid provider event type"), { status: 400 });
  const msgId = String(messageId || "").slice(0, 300);
  let event;
  try { event = await ProviderEvent.create({ eventId, type, messageId: msgId }); }
  catch (e) {
    if (e.code !== 11000) throw e;
    event = await ProviderEvent.findOne({ eventId });
    if (!event || event.type !== type || event.messageId !== msgId) throw Object.assign(new Error("Conflicting event ID"), { status: 409 });
    if (event.processedAt) return { duplicate: true };
  }
  let result;
  if (type === "suspended") {
    await monitoring.pauseQueues("all", "provider_suspension_reported", "webhook");
    result = { recorded: true };
  } else if (type === "warning") {
    await monitoring.warning("all", "provider_account_warning");
    result = { recorded: true };
  } else {
    const doc = msgId ? await Outbound.findOne({ providerMessageId: msgId }) : null;
    if (!doc) result = { recorded: true, matched: false };
    else {
      if (type === "delivered" && doc.status === "accepted") {
        await Outbound.updateOne({ _id: doc._id, status: "accepted" }, { $set: { status: "delivered", deliveredAt: new Date() } });
      }
      if (["hard_bounce", "complaint", "unsubscribed"].includes(type)) {
        await suppress(doc.addressHash, type === "unsubscribed" ? "marketing" : "all", type === "hard_bounce" ? "hard_bounce" : type === "complaint" ? "complaint" : "unsubscribe");
        if (type !== "unsubscribed") {
          const oldStatus = type === "complaint" ? "complained" : "bounced";
          const updated = await Outbound.updateOne({ _id: doc._id, status: { $nin: ["bounced", "complained"] } }, { $set: { status: oldStatus, reason: `provider_${type}` } });
          if (updated.modifiedCount) {
            await monitoring.recordMetric(type === "complaint" ? "complaint" : "bounce", String(doc._id));
            await monitoring.checkRisk();
          }
        }
      }
      result = { recorded: true, matched: true };
    }
  }
  await ProviderEvent.updateOne({ _id: event._id }, { $set: { processedAt: new Date() } });
  return result;
}
async function unsubscribe(token) {
  const id = verifyUnsubscribeToken(token);
  if (!id) throw Object.assign(new Error("Invalid unsubscribe token"), { status: 400 });
  const item = await Outbound.findOne({ _id: id, category: "marketing" }).select("addressHash");
  if (!item) throw Object.assign(new Error("Unsubscribe request not found"), { status: 404 });
  await suppress(item.addressHash, "marketing", "unsubscribe");
  // Persistent consent revocation: queued campaigns and subsequent campaigns also skip.
  await User.updateOne({ email: item.to, userType: "client" }, { $set: { "marketingEmailConsent.enabled": false, "marketingEmailConsent.unsubscribedAt": new Date() } });
  return { unsubscribed: true };
}
module.exports = { enqueueEmail, startWorkers, stopWorkers, reconcileOutbox, createCampaign, recordProviderEvent, unsubscribe, verifyUnsubscribeToken, isSuppressed, suppress, waitForAcceptance, processDelivery, processCampaign, ensureRedisQuotaState };
