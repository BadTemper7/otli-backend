"use strict";
// Optional real BullMQ/Redis/Mongo integration tests. NEVER touch SMTP:
// EMAIL_RUN_INTEGRATION=true EMAIL_TEST_MONGODB_URI=... REDIS_URL=... npm run test:integration
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const enabled = process.env.EMAIL_RUN_INTEGRATION === "true";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(150); }
  throw new Error("Timed out waiting for mocked email job state");
}
test("real Redis/Mongo queue: consent, suppression, duplicates, provider faults, suspension and restart quarantine", { skip: !enabled, timeout: 90000 }, async () => {
  if (!process.env.EMAIL_TEST_MONGODB_URI || !process.env.REDIS_URL) throw new Error("Provide isolated EMAIL_TEST_MONGODB_URI and REDIS_URL");
  process.env.NODE_ENV = "test";
  process.env.EMAIL_DELIVERY_MODE = "mock";
  process.env.EMAIL_MARKETING_ENABLED = "true";
  process.env.EMAIL_PUBLIC_BASE_URL = "https://example.invalid";
  process.env.EMAIL_PAYLOAD_KEY ||= crypto.randomBytes(32).toString("base64");
  process.env.EMAIL_HMAC_SECRET ||= crypto.randomBytes(40).toString("hex");
  process.env.EMAIL_REDIS_PREFIX = `otli:test:${crypto.randomUUID()}`;
  process.env.EMAIL_THROTTLE_COOLDOWN_MS = "1000";
  process.env.EMAIL_RISK_MIN_SAMPLE = "100";
  const mongoose = require("mongoose");
  const database = `otli_email_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await mongoose.connect(process.env.EMAIL_TEST_MONGODB_URI, { dbName: database, serverSelectionTimeoutMS: 10000 });
  assert.equal(mongoose.connection.name, database);
  const User = require("../models/User.js").default;
  const Outbound = require("../models/OutboundEmail.js");
  const Suppression = require("../models/EmailSuppression.js");
  const monitor = require("../services/emailMonitoring.js");
  const service = require("../services/emailService.js");
  const { addressHash, encrypt } = require("../services/emailCrypto.js");
  const { eventHash } = require("../services/emailCrypto.js");
  const { queue, close } = require("../services/emailQueue.js");
  const address = `test+${crypto.randomUUID()}@example.invalid`;
  try {
    const client = await User.create({ name: "Email Integration User", email: address, password: "dummy-password-123", userType: "client", role: "client", status: "active", marketingEmailConsent: { enabled: true, source: "staging_test", consentAt: new Date() } });
    await service.startWorkers();
    const first = await service.enqueueEmail({ to: address, subject: "Test", text: "Mock only", eventKey: "test-first", awaitAcceptance: true });
    assert.equal(first.status, "accepted");
    const copies = await Promise.all(Array.from({length: 30}, () => service.enqueueEmail({ to: address, subject: "Duplicate", text: "Mock only", eventKey: "duplicate-request", awaitAcceptance: false })));
    assert.equal(copies.filter(x => x.created).length, 1);
    await until(async () => (await Outbound.findOne({ eventKey: eventHash(address, "duplicate-request") }))?.status === "accepted", 15000);
    await service.suppress(addressHash(address), "marketing", "unsubscribe");
    const blocked = await service.enqueueEmail({ to: address, subject: "Marketing", text: "Mock", category: "marketing", eventKey: "marketing-1", awaitAcceptance: false });
    assert.equal(blocked.status, "suppressed");
    const bouncedAddress = `bounce+${crypto.randomUUID()}@example.invalid`;
    process.env.EMAIL_MOCK_RESPONSE = "hard_bounce";
    const b = await service.enqueueEmail({ to: bouncedAddress, subject: "Bounce", text: "No real email", eventKey: "bounce-1", awaitAcceptance: false });
    await until(async () => (await Outbound.findById(b.id))?.status === "bounced");
    assert.ok(await Suppression.exists({ addressHash: addressHash(bouncedAddress), scope: "all" }));
    process.env.EMAIL_MOCK_RESPONSE = "suspended";
    const suspendedAddress = `suspended+${crypto.randomUUID()}@example.invalid`;
    await service.enqueueEmail({ to: suspendedAddress, subject: "Provider suspension", text: "Mock", eventKey: "suspend-1", awaitAcceptance: false });
    await until(async () => (await monitor.dashboard()).pauses.all !== null);
    assert.equal((await monitor.dashboard()).status, "Paused");
    await assert.rejects(() => monitor.resumeQueues("all", client._id, "test provider suspension review", false));
    process.env.EMAIL_MOCK_RESPONSE = "accepted";
    await monitor.resumeQueues("all", client._id, "test simulated provider clearance approved", true);
    // Recovery after a worker crash between reservation and provider outcome:
    // this job MUST be quarantined instead of retransmitted.
    const uncertainAddress = `uncertain+${crypto.randomUUID()}@example.invalid`;
    const doc = await Outbound.create({ eventKey: eventHash(uncertainAddress, "stalled-1"), addressHash: addressHash(uncertainAddress), to: uncertainAddress, payload: encrypt({ subject: "Test", text: "Mock" }), category: "transactional", status: "sending" });
    await queue("transactional").add("deliver", { id: String(doc._id) }, { jobId: String(doc._id) });
    await until(async () => (await Outbound.findById(doc._id))?.status === "uncertain");
    assert.equal((await Outbound.findById(doc._id)).attempts, 0);
  } finally {
    delete process.env.EMAIL_MOCK_RESPONSE;
    await service.stopWorkers();
    await close();
    await mongoose.disconnect();
  }
});
