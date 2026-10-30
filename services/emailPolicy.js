"use strict";
const crypto = require("node:crypto");
const integer = (name, fallback, min = 1, max = 10000000) => {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
};
const fraction = (name, fallback) => {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`Invalid ${name}`);
  return n;
};
const policy = () => ({
  limits: [
    [1000, integer("EMAIL_LIMIT_PER_SECOND", 1)],
    [60000, integer("EMAIL_LIMIT_PER_MINUTE", 5)],
    [3600000, integer("EMAIL_LIMIT_PER_HOUR", 50)],
    [86400000, integer("EMAIL_LIMIT_PER_DAY", 100)],
  ],
  marketingProviderFraction: fraction("EMAIL_MARKETING_PROVIDER_FRACTION", .8),
  marketingDaily: integer("EMAIL_MARKETING_PER_RECIPIENT_DAY", 1),
  marketingWeekly: integer("EMAIL_MARKETING_PER_RECIPIENT_WEEK", 2),
  workerConcurrency: integer("EMAIL_WORKER_CONCURRENCY", 1, 1, 10),
  batchSize: integer("EMAIL_BULK_BATCH_SIZE", 200, 1, 1000),
  bulkMax: integer("EMAIL_BULK_MAX_RECIPIENTS", 50000),
  retries: integer("EMAIL_RETRY_ATTEMPTS", 5, 1, 12),
  acceptanceTimeoutMs: integer("EMAIL_ACCEPTANCE_TIMEOUT_MS", 25000, 1000, 120000),
  retryBaseMs: integer("EMAIL_RETRY_BASE_MS", 2000, 100, 600000),
  retryMaxMs: integer("EMAIL_RETRY_MAX_MS", 600000, 1000, 3600000),
  cooldownMs: integer("EMAIL_THROTTLE_COOLDOWN_MS", 60000, 1000, 3600000),
  riskMinSample: integer("EMAIL_RISK_MIN_SAMPLE", 100),
  warningComplaint: fraction("EMAIL_WARN_COMPLAINT_RATE", .001),
  criticalComplaint: fraction("EMAIL_CRIT_COMPLAINT_RATE", .003),
  warningBounce: fraction("EMAIL_WARN_BOUNCE_RATE", .02),
  criticalBounce: fraction("EMAIL_CRIT_BOUNCE_RATE", .05),
  warningFailures: fraction("EMAIL_WARN_FAILURE_RATE", .05),
  criticalFailures: fraction("EMAIL_CRIT_FAILURE_RATE", .10),
  criticalThrottles: integer("EMAIL_CRIT_THROTTLES_PER_HOUR", 5),
  criticalAuth: integer("EMAIL_CRIT_AUTH_FAILURES_PER_HOUR", 3),
  trafficSpikeFactor: integer("EMAIL_TRAFFIC_SPIKE_FACTOR", 4),
  criticalTrafficSpikeFactor: integer("EMAIL_CRIT_TRAFFIC_SPIKE_FACTOR", 8),
  marketingEnabled: process.env.EMAIL_MARKETING_ENABLED === "true",
});
const effectiveLimits = (settings, category) => category === "marketing"
  ? settings.limits.map(([windowMs, max], i) => [windowMs, i === 0 ? max : Math.max(1, Math.floor(max * settings.marketingProviderFraction))])
  : settings.limits;
const normalizeEmail = value => {
  if (typeof value !== "string" || value.length > 254 || /[\r\n,<>\s]/.test(value)) return null;
  const addr = value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return null;
  const [local, domain] = addr.split("@");
  if (local.length > 64 || !local || local.startsWith(".") || local.endsWith(".") || local.includes("..") || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/i.test(local) || !/^[a-z0-9.-]+$/i.test(domain) || domain.split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return null;
  return addr;
};
const delayWithJitter = (attempt, base, max, random = Math.random) => Math.floor(Math.min(max, base * (2 ** Math.min(20, Math.max(0, attempt - 1)))) * (0.5 + random() * 0.5));
const classifyProviderError = err => {
  const code = Number(err?.responseCode || err?.statusCode || 0);
  const type = String(err?.code || "").toUpperCase();
  const detail = `${String(err?.response || "")} ${String(err?.message || "")}`.slice(0, 500).toLowerCase();
  if (/account (?:is )?(?:suspend|disabled|deactivat|blocked)|mailbox (?:is )?suspended|sending privilege.*revoked|provider suspension|outgoing mail (?:has been )?blocked/.test(detail)) return "suspended";
  if (type === "EAUTH" || code === 535 || code === 534 || /authentication (?:failed|error)/.test(detail)) return "auth";
  if (code === 429 || (code >= 400 && code <= 599 && /rate.limit|too many messages|sending limit|daily limit|hourly limit|provider quota|quota exceeded|throttl|limit exceeded/.test(detail))) return "throttle";
  if (code >= 400 && code < 500) return "temporary";
  if ((code === 550 || code === 551 || code === 553) && /user unknown|no such (?:user|mailbox)|recipient address rejected|mailbox unavailable|5\.1\.1/.test(detail)) return "hard_bounce";
  if (code >= 500 && code <= 599) return "permanent";
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(type)) return "temporary";
  // A socket timeout, connection drop or ambiguous response can occur AFTER SMTP DATA.
  // Never retry automatically, because the provider might already have accepted it.
  return "uncertain";
};
const digest = (value, secret) => crypto.createHmac("sha256", secret).update(value).digest("hex");
module.exports = { policy, effectiveLimits, normalizeEmail, classifyProviderError, delayWithJitter, digest };
