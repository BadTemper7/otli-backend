"use strict";

// One SMTP account, registration OTP only. Shared MongoDB reservations prevent
// bursts across Node workers. These caps are conservative until the actual
// Hostinger plan's allowance is confirmed. Never raise them to evade quotas.
const KEY = "registration-otp-smtp";
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Only reservations provably not handed to SMTP can ever be reclaimed.
// The grace period protects a still-running request from administrator cleanup.
const UNUSED_GRACE_MS = 15 * 60 * 1000;
// Calendar-day reporting is separate from the *rolling* safety quota.
// Hostinger's provider limit does not reset at Philippine midnight.
const manilaCalendarDay = (timestampMs) => {
    const localDayStartMs = Math.floor((timestampMs + MANILA_OFFSET_MS) / DAY_MS) * DAY_MS;
    const startMs = localDayStartMs - MANILA_OFFSET_MS;
    return {
        date: new Date(localDayStartMs).toISOString().slice(0, 10),
        startMs,
        nextStartMs: startMs + DAY_MS,
    };
};
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
const recentStages = (doc, timestampMs) => Object.fromEntries(
    Object.entries(doc?.reservationStages || {}).filter(([key, state]) =>
        Number.isSafeInteger(Number(key)) && Number(key) > timestampMs - DAY_MS &&
        ["unused", "smtp_started", "smtp_accepted", "smtp_rejected", "smtp_unconfirmed"].includes(state)),
);
const countUnused = (doc, timestampMs) => Object.entries(recentStages(doc, timestampMs))
    .filter(([key, state]) => state === "unused" && Number(key) <= timestampMs - UNUSED_GRACE_MS)
    .length;
const updateWithVersion = (store, doc, set) => store.updateOne(
    { _id: KEY, version: doc.version },
    { $set: { ...set, updatedAt: new Date() }, $inc: { version: 1 } },
);
const createSlotStateError = () => Object.assign(
    new Error("The OTP sending reservation is no longer available. Please start a new request or submit for manual review."),
    { code: "REGISTRATION_SLOT_UNAVAILABLE", statusCode: 503 },
);

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
    const localDay = manilaCalendarDay(timestampMs);
    // Today resets at 00:00 Asia/Manila for reporting only. Do NOT use this
    // count to allow SMTP sends: Hostinger's quota is rolling 24 hours.
    const calendarToday = {
        date: localDay.date,
        timezone: "Asia/Manila",
        used: status.recent.filter((stamp) => stamp >= localDay.startMs && stamp <= timestampMs).length,
        resetsAt: new Date(localDay.nextStartMs).toISOString(),
    };
    // Explain a full rolling window that spans two Philippine calendar dates
    // without collecting or returning email addresses.
    const perLocalDay = new Map();
    for (const stamp of status.recent) {
        const localDate = manilaCalendarDay(stamp).date;
        perLocalDay.set(localDate, (perLocalDay.get(localDate) || 0) + 1);
    }
    const rollingByLocalDay = [...perLocalDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, used]) => ({ date, used }));
    const stages = recentStages(record, timestampMs);
    const unclassifiedReservations = status.recent.filter((stamp) => !stages[String(stamp)]).length;
    const firstRollingSlotAt = windows.day.remaining === 0 && status.recent.length
        ? new Date(status.recent[0] + DAY_MS).toISOString()
        : null;
    return {
        channel: "registration_otp",
        mailbox: process.env.SMTP_USER || null,
        source: "application_reservations",
        providerQuotaVerified: false,
        providerRemaining: null,
        windows,
        calendarToday,
        rollingByLocalDay,
        reclaimableUnused: countUnused(record, timestampMs),
        // Old reservations have no reliable evidence of SMTP acceptance/failure.
        // They are intentionally never released by the admin action.
        unclassifiedReservations,
        firstRollingSlotAt,
        quotaWindow: "rolling_24_hours",
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
            throw new RegistrationEmailLimitError({
                name: status.limitName || "spacing",
                retryAfterSeconds: status.retryAfterSeconds,
            });
        }
        const updated = [...status.recent, timestampMs].map((stamp) => new Date(stamp));
        const token = String(timestampMs);
        const stages = { ...recentStages(current, timestampMs), [token]: "unused" };
        if (!current) {
            try {
                await store.insertOne({ _id: KEY, version: 1, reservations: updated, reservationStages: stages, updatedAt: currentTime });
                return token;
            } catch (error) {
                if (isDuplicateKey(error)) continue;
                throw error;
            }
        }
        const result = await store.updateOne(
            { _id: KEY, version: current.version },
            { $set: { reservations: updated, reservationStages: stages, updatedAt: currentTime }, $inc: { version: 1 } },
        );
        if (result.matchedCount === 1) return token;
    }
    throw new RegistrationEmailLimitError({ name: "spacing", retryAfterSeconds: 12, message: "Concurrent registration email requests; retry shortly." });
};

// Atomic state transitions coordinate with a concurrent admin cleanup. A
// reclaimed reservation can never be handed to SMTP after reconciliation.
const transitionRegistrationEmailSlot = async ({ token, from, to, collection } = {}) => {
    if (token === true) return true; // Compatibility with legacy mocked callers.
    if (!/^\d{10,17}$/.test(String(token || ""))) throw createSlotStateError();
    const store = getCollection(collection);
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const doc = await store.findOne({ _id: KEY });
        if (!doc || doc.reservationStages?.[token] !== from ||
            !(doc.reservations || []).some((item) => new Date(item).getTime() === Number(token))) {
            throw createSlotStateError();
        }
        const stages = { ...(doc.reservationStages || {}), [token]: to };
        const result = await updateWithVersion(store, doc, { reservationStages: stages });
        if (result.matchedCount === 1) return true;
    }
    throw createSlotStateError();
};

const startRegistrationEmailSend = (options) => transitionRegistrationEmailSlot({ ...options, from: "unused", to: "smtp_started" });
const finishRegistrationEmailSend = async ({ outcome = "smtp_unconfirmed", ...options } = {}) => {
    if (!["smtp_accepted", "smtp_rejected", "smtp_unconfirmed"].includes(outcome)) {
        throw new Error("Invalid email outcome.");
    }
    return transitionRegistrationEmailSlot({ ...options, from: "smtp_started", to: outcome });
};

// Safe only BEFORE any attempt to contact SMTP. If the request fails before
// startRegistrationEmailSend, this restores its slot immediately.
const releaseUnstartedRegistrationEmailSlot = async ({ token, collection } = {}) => {
    if (token === true) return false;
    if (!/^\d{10,17}$/.test(String(token || ""))) return false;
    const store = getCollection(collection);
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const doc = await store.findOne({ _id: KEY });
        if (!doc || doc.reservationStages?.[token] !== "unused") return false;
        const stages = { ...(doc.reservationStages || {}) };
        delete stages[token];
        const reservations = (doc.reservations || []).filter((item) => new Date(item).getTime() !== Number(token));
        const result = await updateWithVersion(store, doc, { reservations, reservationStages: stages });
        if (result.matchedCount === 1) return true;
    }
    return false;
};

// Super-admin recovery removes ONLY the recorded unused pre-SMTP slots older
// than 15 minutes. Unknown legacy slots and any SMTP-started job are preserved.
// Optimistic locking makes this safe against simultaneous registrations/workers.
const reconcileUnusedRegistrationEmailSlots = async ({ collection, now = () => Date.now() } = {}) => {
    const store = getCollection(collection);
    const timestampMs = Number(now());
    if (!Number.isFinite(timestampMs)) throw new Error("Invalid clock.");
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const doc = await store.findOne({ _id: KEY });
        if (!doc) return { released: 0, remaining: 0, legacyHeld: 0 };
        const stages = recentStages(doc, timestampMs);
        const targets = new Set(Object.entries(stages)
            .filter(([key, state]) => state === "unused" && Number(key) <= timestampMs - UNUSED_GRACE_MS)
            .map(([key]) => key));
        if (targets.size === 0) {
            const active = inspectRegistrationEmailLimit(doc.reservations, timestampMs).recent;
            return { released: 0, remaining: active.length, legacyHeld: active.filter((stamp) => !stages[String(stamp)]).length };
        }
        const reservations = (doc.reservations || []).filter((item) => !targets.has(String(new Date(item).getTime())));
        for (const key of targets) delete stages[key];
        const result = await updateWithVersion(store, doc, { reservations, reservationStages: stages });
        if (result.matchedCount !== 1) continue;
        const active = inspectRegistrationEmailLimit(reservations, timestampMs).recent;
        return { released: targets.size, remaining: active.length, legacyHeld: active.filter((stamp) => !stages[String(stamp)]).length };
    }
    throw Object.assign(new Error("Email slot reconciliation is busy. Please retry."), { statusCode: 503 });
};

module.exports = {
    reserveRegistrationEmailSlot,
    getRegistrationEmailStatus,
    inspectRegistrationEmailLimit,
    RegistrationEmailLimitError,
    WINDOW_LIMITS,
    getRegistrationEmailUsage,
    manilaCalendarDay,
    startRegistrationEmailSend,
    finishRegistrationEmailSend,
    releaseUnstartedRegistrationEmailSlot,
    reconcileUnusedRegistrationEmailSlots,
    UNUSED_GRACE_MS,
};
