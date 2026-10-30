"use strict";
/**
 * Real Mongo + Redis enqueue/load test with local MOCK transport only.
 * Never sends an actual email. Uses isolated test DB and test Redis namespace.
 * Usage: EMAIL_TEST_MONGODB_URI=... REDIS_URL=... node scripts/stageEmailQueue.js 10000
 */
require("dotenv").config();
const { performance } = require("node:perf_hooks");
const crypto = require("node:crypto");
const size = Number(process.argv[2] || 1000);
if (![10,100,1000,10000,50000].includes(size)) { console.error("Supported sizes: 10,100,1000,10000,50000"); process.exit(1); }
if (!process.env.EMAIL_TEST_MONGODB_URI || !process.env.REDIS_URL) { console.error("Set EMAIL_TEST_MONGODB_URI and REDIS_URL for isolated staging resources"); process.exit(1); }
// These two overrides are unconditional, so this command CANNOT connect to live SMTP.
process.env.NODE_ENV = "test";
process.env.EMAIL_DELIVERY_MODE = "mock";
delete process.env.EMAIL_MOCK_RESPONSE; // The staging load test always simulates acceptance.
process.env.EMAIL_MARKETING_ENABLED = "false";
process.env.EMAIL_REDIS_PREFIX = `otli:staging-load:${crypto.randomUUID()}`;
process.env.EMAIL_PAYLOAD_KEY = crypto.randomBytes(32).toString("base64");
process.env.EMAIL_HMAC_SECRET = crypto.randomBytes(40).toString("hex");
process.env.EMAIL_LIMIT_PER_SECOND ||= "1";
process.env.EMAIL_LIMIT_PER_MINUTE ||= "5";
process.env.EMAIL_LIMIT_PER_HOUR ||= "50";
process.env.EMAIL_LIMIT_PER_DAY ||= "100";
const mongoose = require("mongoose");
const { enqueueEmail, startWorkers, stopWorkers } = require("../services/emailService.js");
const { queue, close } = require("../services/emailQueue.js");
const { getRateState } = require("../services/emailRateLimiter.js");
const Outbound = require("../models/OutboundEmail.js");
const scope = crypto.randomUUID();
(async () => {
  const started = performance.now();
  const cpuStart = process.cpuUsage();
  const testDb = `otli_email_test_${scope.replaceAll("-", "")}`;
  await mongoose.connect(process.env.EMAIL_TEST_MONGODB_URI, { dbName: testDb, serverSelectionTimeoutMS: 10000 });
  if (mongoose.connection.name !== testDb) throw new Error("Refusing to test outside isolated otli_email_test database");
  await startWorkers();
  // Burst of up to 1,000 concurrent enqueue requests; subsequent blocks use 100
  // to avoid overwhelming a developer machine during the 50k staging exercise.
  const batch = size <= 1000 ? size : 100;
  let created = 0, duplicates = 0;
  for (let base = 0; base < size; base += batch) {
    const jobs = Array.from({ length: Math.min(batch, size - base) }, (_, offset) => base + offset);
    const result = await Promise.all(jobs.map(async i => {
      const to = `load.${scope}.${i}@example.invalid`;
      const first = await enqueueEmail({ to, subject: "Load test", text: "Mock email only", eventKey: `load:${scope}`, awaitAcceptance: false });
      if (i % 25 === 0) {
        const again = await enqueueEmail({ to, subject: "Load test", text: "Mock email only", eventKey: `load:${scope}`, awaitAcceptance: false });
        if (!again.created) duplicates++;
      }
      return first;
    }));
    created += result.filter(x => x.created).length;
  }
  const states = await queue("transactional").getJobCounts("waiting", "active", "delayed", "completed", "failed");
  const rate = await getRateState();
  const dbQueued = await Outbound.countDocuments({ eventType: "notification", to: { $regex: `^load\\.${scope.replaceAll("-", "-")}\\.` }, status: "queued" });
  const cpu = process.cpuUsage(cpuStart);
  console.log(JSON.stringify({ testType: "STAGING_MOCK_NO_REAL_SMTP", configuredSize: size, created, duplicatesPrevented: duplicates, jobStates: states, dbQueued, rate, elapsedSeconds: +((performance.now() - started) / 1000).toFixed(2), heapMiB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1), rssMiB: +(process.memoryUsage().rss / 1048576).toFixed(1), processCpuTimeMs: +((cpu.user + cpu.system) / 1000).toFixed(1) }, null, 2));
})().catch(err => { console.error("Staging load test error:", err.code || "ERROR"); process.exitCode = 1; })
.finally(async () => { await stopWorkers(); await close().catch(() => {}); await mongoose.disconnect().catch(() => {}); });
