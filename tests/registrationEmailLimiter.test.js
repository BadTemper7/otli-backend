"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    reserveRegistrationEmailSlot,
    LIMITS,
} = require("../utils/registrationEmailLimiter.js");

// Minimal fake for the MongoDB atomic operations used by the limiter. No
// server, database, SMTP credentials, or real deliveries are involved.
class FakeCollection {
    constructor() { this.doc = null; }
    async findOne({ _id }) {
        if (!this.doc || this.doc._id !== _id) return null;
        return structuredClone(this.doc);
    }
    async insertOne(doc) {
        if (this.doc) {
            const error = new Error("duplicate key");
            error.code = 11000;
            throw error;
        }
        this.doc = structuredClone(doc);
        return { acknowledged: true };
    }
    async updateOne(filter, update) {
        if (!this.doc || filter._id !== this.doc._id || filter.version !== this.doc.version)
            return { matchedCount: 0 };
        this.doc.sentAt = structuredClone(update.$set.sentAt);
        this.doc.version += update.$inc.version;
        return { matchedCount: 1 };
    }
}

const reserve = (collection, now) =>
    reserveRegistrationEmailSlot({ collection, clock: () => now });

const limited = (code = "REGISTRATION_EMAIL_RATE_LIMIT") => (error) => {
    assert.equal(error.code, code);
    assert.equal(error.statusCode, code === "REGISTRATION_EMAIL_RATE_LIMIT" ? 429 : 503);
    return true;
};

test("one SMTP registration slot every 12 seconds; returns Retry-After", async () => {
    const collection = new FakeCollection();
    await reserve(collection, 1_000_000);
    await assert.rejects(reserve(collection, 1_000_001), (error) => {
        assert.ok(error.retryAfterSeconds >= 1);
        return limited()(error);
    });
    await reserve(collection, 1_012_000);
    assert.equal(collection.doc.sentAt.length, 2);
});

test("one shared MongoDB counter prevents a burst of 1,000 parallel registration sends", async () => {
    const collection = new FakeCollection();
    const results = await Promise.allSettled(
        Array.from({ length: 1000 }, () => reserve(collection, 1_000_000))
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" &&
        result.reason.code === "REGISTRATION_EMAIL_RATE_LIMIT").length, 999);
    assert.equal(collection.doc.sentAt.length, 1);
});

test("the 50-per-hour ceiling is enforced, even without an active one-minute burst", async () => {
    const collection = new FakeCollection();
    const start = 1_000_000;
    for (let i = 0; i < LIMITS.perHour; i += 1) {
        await reserve(collection, start + i * LIMITS.minSpacingMs);
    }
    await assert.rejects(reserve(collection, start + 600_000), limited());
    await reserve(collection, start + 3_600_000);
    assert.equal(collection.doc.sentAt.length, 51);
});

test("the 100-per-rolling-day ceiling survives a simulated process restart", async () => {
    const collection = new FakeCollection();
    const start = 1_000_000;
    for (let i = 0; i < 50; i += 1) {
        await reserve(collection, start + i * LIMITS.minSpacingMs);
    }
    for (let i = 0; i < 50; i += 1) {
        await reserve(collection, start + 3_600_000 + i * LIMITS.minSpacingMs);
    }
    assert.equal(collection.doc.sentAt.length, 100);
    // Same collection represents surviving MongoDB data after a Node restart.
    await assert.rejects(reserve(collection, start + 4_800_000), limited());
    await reserve(collection, start + 86_400_000);
    assert.equal(collection.doc.sentAt.length, 100);
});

test("the limiter fails closed if MongoDB is disconnected", async () => {
    const brokenDb = {
        async findOne() { throw new Error("test disconnection"); },
    };
    await assert.rejects(reserve(brokenDb, 1_000_000), limited("REGISTRATION_EMAIL_UNAVAILABLE"));
});
