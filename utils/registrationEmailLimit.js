"use strict";

// Single Hostinger SMTP account, registration OTP only. These conservative
// limits are fixed in code; no Redis, packages, migrations or .env additions.
// Reservations use one MongoDB document (via the app's existing connection)
// and compare-and-swap to prevent bursts across Node.js processes.
const KEY = "registration-otp-smtp";
const WINDOW_LIMITS = [
    { name: "spacing", durationMs: 12 * 1000, max: 1 },
    { name: "minute", durationMs: 60 * 1000, max: 5 },
    { name: "hour", durationMs: 60 * 60 * 1000, max: 50 },
    { name: "day", durationMs: 24 * 60 * 60 * 1000, max: 100 },
];

class RegistrationEmailLimitError extends Error {
    constructor(message = "Registration OTP sending limit reached.") {
        super(message);
        this.name = "RegistrationEmailLimitError";
        this.code = "REGISTRATION_EMAIL_LIMIT";
        this.statusCode = 429;
    }
}

const isDuplicateKey = (error) => error?.code === 11000;

// A reservation counts against the limit even if SMTP later times out: the
// provider may have accepted an email before the connection was interrupted.
const reserveRegistrationEmailSlot = async ({ collection, now = () => Date.now() } = {}) => {
    const store = collection || require("mongoose").connection.db.collection("registration_email_limits");
    // Under contention, fail closed rather than allow a possible extra send.
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const current = await store.findOne({ _id: KEY });
        const timestampMs = Number(now());
        if (!Number.isFinite(timestampMs)) throw new Error("Invalid clock for registration email limiter.");
        const currentTime = new Date(timestampMs);
        const lastDay = timestampMs - 24 * 60 * 60 * 1000;
        // Older reservations are removed; never store OTPs, emails, or IPs.
        const recent = (current?.reservations || [])
            .map((stamp) => new Date(stamp).getTime())
            .filter((stamp) => Number.isFinite(stamp) && stamp > lastDay);

        for (const { name, durationMs, max } of WINDOW_LIMITS) {
            if (recent.filter((stamp) => stamp > timestampMs - durationMs).length >= max) {
                throw new RegistrationEmailLimitError(`Registration email ${name} limit reached.`);
            }
        }

        const updated = [...recent, timestampMs].map((stamp) => new Date(stamp));
        if (!current) {
            try {
                await store.insertOne({
                    _id: KEY,
                    version: 1,
                    reservations: updated,
                    updatedAt: currentTime,
                });
                return true;
            }
            catch (error) {
                if (isDuplicateKey(error)) continue; // another instance won
                throw error;
            }
        }

        const result = await store.updateOne(
            { _id: KEY, version: current.version },
            { $set: { reservations: updated, updatedAt: currentTime }, $inc: { version: 1 } },
        );
        if (result.matchedCount === 1) return true;
    }
    throw new RegistrationEmailLimitError("Too many concurrent registration email requests.");
};

module.exports = {
    reserveRegistrationEmailSlot,
    RegistrationEmailLimitError,
    WINDOW_LIMITS,
};
