"use strict";
const { redis, queue } = require("./emailQueue.js");
const { k } = require("./emailRateLimiter.js");
const { policy } = require("./emailPolicy.js");
const Incident = require("../models/EmailIncident.js");
const Outbound = require("../models/OutboundEmail.js");
const Suppression = require("../models/EmailSuppression.js");
const User = require("../models/User.js").default;
const Notification = require("../models/Notification.js").default;
const { emitToUser } = require("../socket/socket.js");
const { getRateState } = require("./emailRateLimiter.js");
const types = ["attempt", "accepted", "bounce", "complaint", "failed", "throttle", "auth"];
async function recordMetric(type, id) {
  if (!types.includes(type)) return;
  const now = Date.now();
  const key = k(`metric:${type}`);
  const r = redis();
  const transaction = r.multi();
  transaction.zadd(key, now, `${id}:${now}`);
  transaction.zremrangebyscore(key, "-inf", now - 86400000);
  transaction.pexpire(key, 90000000);
  await transaction.exec();
}
async function metricCounts() {
  const now = Date.now();
  const r = redis();
  const vals = await Promise.all(types.map(type => r.zcount(k(`metric:${type}`), now - 86400000, "+inf")));
  return Object.fromEntries(types.map((type, i) => [type, vals[i]]));
}
async function pauseQueues(category, reason, source = "monitor", severity = "critical") {
  if (!["all", "marketing", "transactional"].includes(category)) throw new Error("Invalid category");
  // Redis pause flag goes first. Sending workers consult it before SMTP.
  await redis().set(k(`paused:${category}`), String(reason).slice(0, 180));
  const names = category === "all" ? ["transactional", "marketing", "campaigns"] : category === "marketing" ? ["marketing", "campaigns"] : ["transactional"];
  await Promise.all(names.map(name => queue(name).pause()));
  const existing = await Incident.findOne({ category, severity, reason, clearedAt: null });
  if (existing) return existing;
  const alert = await Incident.create({ category, severity, reason, source });
  // In-app alerts, NOT mail: SMTP may be suspended.
  try {
    const admins = await User.find({ userType: "admin", role: "super_admin", status: "active" }).select("_id").lean();
    for (const admin of admins) {
      const item = await Notification.create({ recipient: admin._id, type: "email_safety", title: "Email sending paused", message: `Email ${category} paused: ${reason}`, actionPath: "/admin/email-monitoring", metadata: { incidentId: String(alert._id) } });
      emitToUser(admin._id, "notification:created", { id: String(item._id), type: "email_safety", title: item.title, message: item.message });
    }
  } catch { /* Alerts remain available in incident dashboard if sockets/notifications are down. */ }
  return alert;
}
async function warning(category, reason) {
  const recent = await Incident.findOne({ category, severity: "warning", reason, createdAt: { $gte: new Date(Date.now() - 3600000) } });
  return recent || Incident.create({ category, severity: "warning", reason });
}
async function checkRisk() {
  const p = policy();
  const c = await metricCounts();
  if (c.auth >= p.criticalAuth) await pauseQueues("all", "repeated_smtp_auth_failures");
  if (c.throttle >= p.criticalThrottles) await pauseQueues("all", "repeated_provider_throttling");
  if (c.accepted >= p.riskMinSample) {
    const ratios = [
      ["complaint", c.complaint / c.accepted, p.warningComplaint, p.criticalComplaint],
      ["bounce", c.bounce / c.accepted, p.warningBounce, p.criticalBounce],
      ["failed", c.failed / c.accepted, p.warningFailures, p.criticalFailures],
    ];
    for (const [type, ratio, warn, critical] of ratios) {
      if (ratio >= critical) await pauseQueues("marketing", `high_${type}_rate`);
      else if (ratio >= warn) await warning("marketing", `elevated_${type}_rate`);
    }
  }
  const now = Date.now();
  const [recent, previous] = await Promise.all([
    redis().zcount(k("metric:attempt"), now - 3600000, "+inf"),
    redis().zcount(k("metric:attempt"), now - 7200000, now - 3600001),
  ]);
  if (recent >= p.riskMinSample && previous > 0) {
    if (recent >= previous * p.criticalTrafficSpikeFactor) await pauseQueues("marketing", "critical_unexpected_volume_spike");
    else if (recent >= previous * p.trafficSpikeFactor) await warning("marketing", "unexpected_volume_spike");
  }
  return c;
}
async function resumeQueues(category, actor, note, providerClearance) {
  if (!["all", "marketing", "transactional"].includes(category)) throw new Error("Invalid queue category");
  const open = await Incident.find({ clearedAt: null, severity: "critical", category: category === "all" ? { $in: ["all", "transactional", "marketing"] } : { $in: [category, "all"] } });
  const storedReasons = await Promise.all(["all", ...(category === "all" ? ["marketing", "transactional"] : [category])].map(knd => redis().get(k(`paused:${knd}`))));
  if ((open.some(x => /provider_suspension|smtp_auth|quota|sender_identity/.test(x.reason)) || storedReasons.some(value => /provider_suspension|smtp_auth|quota|sender_identity/.test(value || ""))) && !providerClearance) throw Object.assign(new Error("Provider clearance confirmation is required"), { status: 409 });
  if (!note || note.trim().length < 12) throw Object.assign(new Error("Document recovery steps (at least 12 characters)"), { status: 400 });
  if (open.some(x => x.reason.includes("crypto_key_changed"))) {
    const crypto = require("node:crypto");
    const { key, secret } = require("./emailCrypto.js");
    const SafetyState = require("../models/EmailSafetyState.js");
    const guard = await SafetyState.findOne({ key: "cryptographic-identity-guard" });
    if (!guard || guard.hmacFingerprint !== crypto.createHash("sha256").update(secret()).digest("hex") || guard.payloadFingerprint !== crypto.createHash("sha256").update(key()).digest("hex")) {
      throw Object.assign(new Error("Restore the original encryption/HMAC keys or perform a documented data migration before resuming"), { status: 409 });
    }
  }
  // A scoped resume may not clear incidents while a provider-global pause is active.
  const unresolvedGlobal = await Incident.exists({ category: "all", severity: "critical", clearedAt: null });
  if (category !== "all" && unresolvedGlobal) throw Object.assign(new Error("Global incident still active"), { status: 409 });
  const now = new Date();
  await Incident.updateMany({ _id: { $in: open.filter(x => category === "all" || x.category === category).map(x => x._id) } }, { $set: { clearedAt: now, clearedBy: actor, clearanceNote: note.slice(0, 1000) } });
  if (category === "all") {
    if (open.some(x => /quota|sender_identity/.test(x.reason))) {
      const { digest } = require("./emailPolicy.js");
      const { secret } = require("./emailCrypto.js");
      const SafetyState = require("../models/EmailSafetyState.js");
      const id = digest(`${process.env.SMTP_HOST || ""}|${process.env.SMTP_USER || ""}`, secret());
      await SafetyState.updateOne({ key: id }, { $setOnInsert: { key: id } }, { upsert: true });
      // Admin must document 24-hour quota reconciliation/clearance before resuming.
      await redis().set(k("quota-sentinel"), id);
    }
    await redis().del(k("paused:all"), k("paused:marketing"), k("paused:transactional"));
    for (const kind of ["transactional", "marketing", "campaigns"]) await queue(kind).resume();
  } else {
    await redis().del(k(`paused:${category}`));
    for (const kind of (category === "marketing" ? ["marketing", "campaigns"] : ["transactional"])) await queue(kind).resume();
  }
  return now;
}
async function ensureIncidentPauses() {
  const open = await Incident.find({ severity: "critical", clearedAt: null }).select("category reason");
  for (const item of open) {
    await redis().set(k(`paused:${item.category}`), item.reason);
    for (const name of item.category === "all" ? ["transactional", "marketing", "campaigns"] : item.category === "marketing" ? ["marketing", "campaigns"] : ["transactional"]) await queue(name).pause();
  }
  // If Redis was restarted without persistence, absence of incident must not silently resume
  // queues that are explicitly paused in Redis.
}
async function dashboard() {
  const now = Date.now();
  const [queueCounts, stats, total, suppressed, incidents, metrics, rate, pauses] = await Promise.all([
    Promise.all(["transactional", "marketing", "campaigns"].map(async name => ({ name, counts: await queue(name).getJobCounts("waiting", "active", "delayed", "completed", "failed", "paused"), paused: await queue(name).isPaused() }))),
    Outbound.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    Outbound.countDocuments(), Suppression.countDocuments(),
    Incident.find({ clearedAt: null }).sort({ createdAt: -1 }).limit(30).select("-__v").lean(),
    metricCounts(), getRateState(), Promise.all(["all", "transactional", "marketing"].map(name => redis().get(k(`paused:${name}`)))),
  ]);
  const counts = Object.fromEntries(stats.map(x => [x._id, x.count]));
  const status = (pauses.some(Boolean) || queueCounts.some(x => x.paused)) ? "Paused" : incidents.some(x => x.severity === "warning") ? "Warning" : "Healthy";
  const accepted = await Outbound.countDocuments({ acceptedAt: { $ne: null } });
  return {
    status, totals: {
      queued: counts.queued || 0, accepted, delivered: counts.delivered || 0, failed: counts.failed || 0,
      bounced: counts.bounced || 0, complaints: counts.complained || 0,
      suppressedRecipients: suppressed, uncertain: counts.uncertain || 0,
      totalMessages: total,
    }, rate, currentRatePerMinute: await redis().zcount(k("metric:accepted"), now - 60000, "+inf"),
    recent24h: metrics, queues: queueCounts, pauses: { all: pauses[0] || null, transactional: pauses[1] || null, marketing: pauses[2] || null }, incidents,
    deliveryTracking: "SMTP acceptance does not confirm inbox delivery. Confirmed delivered requires provider events.",
  };
}
module.exports = { recordMetric, checkRisk, pauseQueues, resumeQueues, ensureIncidentPauses, dashboard, warning };
