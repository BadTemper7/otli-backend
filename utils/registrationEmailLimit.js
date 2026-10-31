"use strict";

// One SMTP account, registration OTP only. Shared MongoDB reservations prevent
// bursts across Node workers. These caps are conservative until the actual
// Hostinger plan's allowance is confirmed. Never raise them to evade quotas.
const KEY = "registration-otp-smtp";
const WINDOW_LIMITS = [
    { name: "spacing", durationMs: 12 * 1000, max: 1 },
    { name: "minute", durationMs: 60 * 1000, max: 5 },
    { name: "hour", durationMs: 60 * 60 * 1000, max: 50 },
    { name: "day", durationMs: 24 * 60 * 60 * 1000, max: 100 },
];

class RegistrationEmailLimitError extends Error {
    constructor({ name = "spacing", retryAfterSeconds = 12, message } = {}) {
        super(message || `Registration email ${name} limit reached.`);
        this.name = "RegistrationEmailLimitError";
        this.code = "REGISTRATION_EMAIL_LIMIT";
        this.statusCode = 429;
        this.limitName = name;
        this.retryAfterSeconds = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 12));
    }
}

const isDuplicateKey = (error) => error?.code === 11000;
const getCollection = (collection) => collection || require("mongoose").connection.db.collection("registration_email_limits");

// The longest active window determines when a sending slot will truly be free.
// This is also returned to the registration form so the user is not told to
// retry blindly or repeatedly re-upload large documents.
const inspectRegistrationEmailLimit = (reservations, timestampMs) => {
    const cutoff = timestampMs - 24 * 60 * 60 * 1000;
    const recent = (reservations || [])
        .map((stamp) => new Date(stamp).getTime())
        .filter((stamp) => Number.isFinite(stamp) && stamp > cutoff)
        .sort((a, b) => a - b);
    let retryAfterMs = 0;
    let blockingWindow = null;
    for (const window of WINDOW_LIMITS) {
        const inWindow = recent.filter((stamp) => stamp > timestampMs - window.durationMs);
        if (inWindow.length < window.max) continue;
        const resetAt = inWindow[inWindow.length - window.max] + window.durationMs;
        if (resetAt - timestampMs > retryAfterMs) {
            retryAfterMs = resetAt - timestampMs;
            blockingWindow = window.name;
        }
    }
    return {
        allowed: retryAfterMs <= 0,
        retryAfterSeconds: Math.max(0, Math.ceil(retryAfterMs / 1000)),
        limitName: blockingWindow,
        recent,
    };
};

const getRegistrationEmailStatus = async ({ collection, now = () => Date.now() } = {}) => {
    const current = await getCollection(collection).findOne({ _id: KEY });
    const timestampMs = Number(now());
    if (!Number.isFinite(timestampMs)) throw new Error("Invalid clock for registration email limiter.");
    const { allowed, retryAfterSeconds, limitName } = inspectRegistrationEmailLimit(current?.reservations, timestampMs);
    return { allowed, retryAfterSeconds, limitName };
};

// Administrative view of OneTrue's own SMTP reservations. This does NOT
// query Hostinger or include messages sent from webmail/another service.
// Reservations count attempts rather than confirmed delivery. A failed or
// ambiguous SMTP send intentionally retains its slot for quota safety.
const getRegistrationEmailUsage = async ({ collection, now = () => Date.now() } = {}) => {
    const timestampMs = Number(now());
    if (!Number.isFinite(timestampMs)) throw new Error("Invalid clock for registration email limiter.");
    const record = await getCollection(collection).findOne({ _id: KEY });
    const status = inspectRegistrationEmailLimit(record?.reservations, timestampMs);
    const windows = {};
    for (const window of WINDOW_LIMITS) {
        const used = status.recent.filter((stamp) => stamp > timestampMs - window.durationMs).length;
        windows[window.name] = {
            limit: window.max,
            used,
            remaining: Math.max(0, window.max - used),
            durationSeconds: window.durationMs / 1000,
        };
    }
    return {
        channel: "registration_otp",
        mailbox: process.env.SMTP_USER || null,
        source: "application_reservations",
        providerQuotaVerified: false,
        providerRemaining: null,
        windows,
        canSendNow: status.allowed,
        blockingWindow: status.limitName,
        retryAfterSeconds: status.retryAfterSeconds,
        nextAvailableAt: status.allowed ? null : new Date(timestampMs + status.retryAfterSeconds * 1000).toISOString(),
        measuredAt: new Date(timestampMs).toISOString(),
    };
};

// Reserve before sending; even an uncertain SMTP timeout counts as an attempt.
// We never automatically resend messages whose delivery is unknown.
const reserveRegistrationEmailSlot = async ({ collection, now = () => Date.now() } = {}) => {
    const store = getCollection(collection);
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const current = await store.findOne({ _id: KEY });
        const timestampMs = Number(now());
        if (!Number.isFinite(timestampMs)) throw new Error("Invalid clock for registration email limiter.");
        const currentTime = new Date(timestampMs);
        const status = inspectRegistrationEmailLimit(current?.reservations, timestampMs);
        if (!status.allowed) {
            throw new RegistrationEmailLimitError(status);
        }
        const updated = [...status.recent, timestampMs].map((stamp) => new Date(stamp));
        if (!current) {
            try {
                await store.insertOne({ _id: KEY, version: 1, reservations: updated, updatedAt: currentTime });
                return true;
            } catch (error) {
                if (isDuplicateKey(error)) continue;
                throw error;
            }
        }
        const result = await store.updateOne(
            { _id: KEY, version: current.version },
            { $set: { reservations: updated, updatedAt: currentTime }, $inc: { version: 1 } },
        );
        if (result.matchedCount === 1) return true;
    }
    throw new RegistrationEmailLimitError({ name: "spacing", retryAfterSeconds: 12, message: "Concurrent registration email requests; retry shortly." });
};

module.exports = {
    reserveRegistrationEmailSlot,
    getRegistrationEmailStatus,
    inspectRegistrationEmailLimit,
    RegistrationEmailLimitError,
    WINDOW_LIMITS,
    getRegistrationEmailUsage,
};
