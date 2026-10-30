"use strict";

// One SMTP account, one shared budget. No Redis, queue, new packages, or .env settings.
// Existing MongoDB stores only reservation timestamps (never recipients or OTPs).
// These conservative ceilings are deliberately fixed until the Hostinger plan is verified.
const MIN_SPACING_MS = 12 * 1000;
const WINDOWS = [
    { durationMs: 60 * 1000, max: 5 },
    { durationMs: 60 * 60 * 1000, max: 50 },
    { durationMs: 24 * 60 * 60 * 1000, max: 100 },
];
const KEY = "registration-otp-smtp";
const COLLECTION = "registration_email_limits";

const makeError = (code, statusCode, message, retryAfterSeconds = 0) => {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    if (retryAfterSeconds > 0)
        error.retryAfterSeconds = retryAfterSeconds;
    return error;
};

const unavailable = () => makeError(
    "REGISTRATION_EMAIL_UNAVAILABLE",
    503,
    "Registration email is temporarily unavailable. Please try again later."
);

const calculateNextAvailableAt = (timestamps, now) => {
    let availableAt = now;
    const last = timestamps[timestamps.length - 1];
    if (last !== undefined)
        availableAt = Math.max(availableAt, last + MIN_SPACING_MS);
    for (const { durationMs, max } of WINDOWS) {
        const active = timestamps.filter((time) => time > now - durationMs);
        if (active.length >= max)
            availableAt = Math.max(availableAt, active[active.length - max] + durationMs);
    }
    return availableAt;
};

// Optimistic compare-and-swap on one MongoDB document keeps the shared SMTP
// quota safe across concurrent Express instances and server restarts.
// Reject excess registrations with HTTP 429 rather than queueing expiring OTPs.
const reserveRegistrationEmailSlot = async ({ collection, clock = Date.now } = {}) => {
    if (!collection) {
        // Lazy require permits dependency-free, mocked limiter tests.
        const mongoose = require("mongoose");
        const db = mongoose.connection.db;
        if (!db)
            throw unavailable();
        collection = db.collection(COLLECTION);
    }

    for (let attempt = 0; attempt < 12; attempt += 1) {
        const now = clock();
        let doc;
        try {
            doc = await collection.findOne({ _id: KEY });
            if (!doc) {
                try {
                    await collection.insertOne({
                        _id: KEY,
                        version: 1,
                        sentAt: [new Date(now)],
                    });
                    return;
                }
                catch (error) {
                    if (error.code === 11000)
                        continue; // another server reserved the first slot
                    throw error;
                }
            }
            if (!Number.isInteger(doc.version) || !Array.isArray(doc.sentAt))
                throw unavailable();

            const timestamps = doc.sentAt.map((date) => new Date(date).getTime());
            if (timestamps.some((time) => !Number.isFinite(time)))
                throw unavailable();
            // Data is maintained in order by CAS. Keep the last day only.
            const recent = timestamps.filter((time) => time > now - WINDOWS[2].durationMs);
            const availableAt = calculateNextAvailableAt(recent, now);
            if (availableAt > now) {
                throw makeError(
                    "REGISTRATION_EMAIL_RATE_LIMIT",
                    429,
                    "Registration email sending limit reached. Please try again later.",
                    Math.ceil((availableAt - now) / 1000)
                );
            }

            const result = await collection.updateOne(
                { _id: KEY, version: doc.version },
                {
                    $set: { sentAt: [...recent.map((time) => new Date(time)), new Date(now)] },
                    $inc: { version: 1 },
                }
            );
            if (result.matchedCount === 1)
                return;
        }
        catch (error) {
            if (error.code === "REGISTRATION_EMAIL_RATE_LIMIT" || error.code === "REGISTRATION_EMAIL_UNAVAILABLE")
                throw error;
            // Fail closed if the shared counter cannot be checked.
            console.warn("[registration-mail-limit] MongoDB limiter unavailable", { code: error.code || "db_error" });
            throw unavailable();
        }
    }
    throw makeError(
        "REGISTRATION_EMAIL_RATE_LIMIT",
        429,
        "Registration email sending is busy. Please try again shortly.",
        12
    );
};

module.exports = {
    reserveRegistrationEmailSlot,
    calculateNextAvailableAt,
    LIMITS: Object.freeze({ minSpacingMs: MIN_SPACING_MS, perMinute: 5, perHour: 50, perDay: 100 }),
};
