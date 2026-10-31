"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  getRegistrationEmailUsage,
  reserveRegistrationEmailSlot,
} = require("../utils/registrationEmailLimit.js");

class MockCollection {
  doc = null;
  writes = 0;
  async findOne() {
    return this.doc ? structuredClone(this.doc) : null;
  }
  async insertOne(doc) {
    this.writes += 1;
    if (this.doc) throw Object.assign(new Error("duplicate key"), { code: 11000 });
    this.doc = structuredClone(doc);
    return { insertedId: doc._id };
  }
  async updateOne(filter, update) {
    this.writes += 1;
    if (!this.doc || this.doc.version !== filter.version) return { matchedCount: 0 };
    this.doc = { ...this.doc, ...structuredClone(update.$set), version: this.doc.version + update.$inc.version };
    return { matchedCount: 1 };
  }
}

const source = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("email dashboard: unused rolling limits show 100 application slots, not a provider quota", async () => {
  const collection = new MockCollection();
  const now = Date.parse("2026-10-31T02:00:00Z");
  const usage = await getRegistrationEmailUsage({ collection, now: () => now });
  assert.equal(usage.windows.day.limit, 100);
  assert.equal(usage.windows.day.remaining, 100);
  assert.equal(usage.windows.hour.remaining, 50);
  assert.equal(usage.windows.minute.remaining, 5);
  assert.equal(usage.canSendNow, true);
  assert.equal(usage.providerQuotaVerified, false);
  assert.equal(usage.providerRemaining, null);
  assert.equal(usage.nextAvailableAt, null);
  assert.equal(usage.source, "application_reservations");
  assert.equal(collection.writes, 0, "report must be read only");
});

test("email dashboard: counts reserved OTP attempts across minute, hour and day", async () => {
  const collection = new MockCollection();
  const start = 3_000_000_000_000;
  await reserveRegistrationEmailSlot({ collection, now: () => start });
  await reserveRegistrationEmailSlot({ collection, now: () => start + 12_000 });
  const before = collection.writes;
  const usage = await getRegistrationEmailUsage({ collection, now: () => start + 14_000 });
  assert.equal(usage.windows.minute.used, 2);
  assert.equal(usage.windows.minute.remaining, 3);
  assert.equal(usage.windows.hour.used, 2);
  assert.equal(usage.windows.day.remaining, 98);
  assert.equal(usage.canSendNow, false);
  assert.equal(usage.blockingWindow, "spacing");
  assert.equal(usage.retryAfterSeconds, 10);
  assert.equal(usage.nextAvailableAt, new Date(start + 24_000).toISOString());
  assert.equal(collection.writes, before);
  assert.equal(usage.mailbox, null, "may hide mailbox when SMTP_USER is not set");
});

test("email dashboard: full 24-hour limit prevents sending and recovers as slots age out", async () => {
  const collection = new MockCollection();
  const start = 3_000_000_000_000;
  for (let n = 0; n < 100; n += 1) {
    await reserveRegistrationEmailSlot({ collection, now: () => start + n * 80_000 });
  }
  const usage = await getRegistrationEmailUsage({ collection, now: () => start + 8_000_000 });
  assert.equal(usage.windows.day.remaining, 0);
  assert.equal(usage.windows.hour.remaining > 0, true);
  assert.equal(usage.blockingWindow, "day");
  assert.equal(usage.canSendNow, false);
  assert.equal(usage.nextAvailableAt, new Date(start + 86_400_000).toISOString());
  const next = await getRegistrationEmailUsage({ collection, now: () => start + 86_400_000 });
  assert.equal(next.windows.day.used, 99);
  assert.equal(next.windows.day.remaining, 1);
  assert.equal(next.canSendNow, true);
});

test("email dashboard: disconnected MongoDB fails visibly instead of displaying fictitious availability", async () => {
  const collection = { findOne: async () => { throw new Error("DB disconnected"); } };
  await assert.rejects(
    getRegistrationEmailUsage({ collection, now: () => 3_000_000_000_000 }),
    /DB disconnected/,
  );
});

test("email dashboard: monitoring controller has no SMTP privileges or secrets", async () => {
  const content = source("controllers/emailUsageController.js");
  const sandbox = { module: { exports: {} }, exports: {}, require: () => ({
    getRegistrationEmailUsage: async () => ({ mailbox: "sender@example.test", windows: { day: { limit: 100, used: 1, remaining: 99 } } }),
  }) };
  vm.runInNewContext(content, sandbox, { timeout: 1000 });
  const headers = {};
  let payload;
  await sandbox.module.exports.getEmailUsage({}, {
    set: (name, value) => { headers[name] = value; },
    json: (data) => { payload = data; },
  });
  assert.equal(payload.success, true);
  assert.equal(payload.windows.day.remaining, 99);
  assert.equal(headers["Cache-Control"], "private, no-store");
  assert.doesNotMatch(content, /sendMail\(|SMTP_PASS|process\.env\.JWT_SECRET/);
});

test("email dashboard: endpoint requires existing admin and dashboard:view permissions", () => {
  const routes = source("routes/adminRoutes.js");
  assert.match(routes, /router\.use\(authMiddleware_js_1\.protect, authMiddleware_js_1\.adminOnly\)/);
  assert.match(routes, /"\/email-usage",\s*\(0, authMiddleware_js_1\.requireAnyPermission\)/);
  assert.match(routes, /\[\["dashboard", "view"\], \["reports", "view"\]\]/);
  const server = source("server.js");
  assert.match(server, /adminRoutes/);
});
