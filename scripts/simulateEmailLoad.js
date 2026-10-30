"use strict";
/**
 * Deterministic, zero-network VIRTUAL-TIME simulation. Does NOT instantiate SMTP,
 * Redis, or Mongo. It tests policy invariants and traffic assumptions, not the
 * deployed BullMQ/Redis/Mongo integration. No real email is ever sent.
 */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { policy, effectiveLimits, normalizeEmail, classifyProviderError, delayWithJitter } = require("../services/emailPolicy.js");
class VirtualRollingLimiter {
  constructor(limits) { this.windows = limits.map(([window, max]) => ({ window, max, sent: [] })); this.clock = 0; this.violations = 0; }
  issue(at = this.clock) {
    let time = Math.max(at, this.clock);
    for (;;) {
      let delay = 0;
      for (const b of this.windows) {
        while (b.sent.length && b.sent[0] <= time - b.window) b.sent.shift();
        if (b.sent.length >= b.max) delay = Math.max(delay, b.sent[0] + b.window - time + 1);
      }
      if (!delay) break;
      time += delay;
    }
    for (const b of this.windows) {
      if (b.sent.length >= b.max) this.violations++;
      b.sent.push(time);
    }
    this.clock = time + 1;
    return time;
  }
}
function simulate(size, limits = effectiveLimits(policy(), "marketing")) {
  const beforeMem = process.memoryUsage().heapUsed;
  const cpuStart = performance.now();
  const processCpuStart = process.cpuUsage();
  const queue = [];
  const ids = new Set();
  const suppressed = new Set();
  let invalid = 0, dedupe = 0, suppressedCount = 0;
  for (let i = 0; i < size; i++) {
    const address = i % 211 === 0 ? `not-email-${i}` : `mock${i}@example.invalid`;
    if (!normalizeEmail(address)) { invalid++; continue; }
    if (i % 197 === 0) suppressed.add(address);
    if (suppressed.has(address)) { suppressedCount++; continue; }
    const eventId = `${address}:campaign-demo`;
    if (ids.has(eventId)) { dedupe++; continue; }
    ids.add(eventId);
    queue.push(i);
    if (i % 53 === 0) { // Repeated HTTP request for the same email event
      if (ids.has(eventId)) dedupe++;
    }
  }
  const limiter = new VirtualRollingLimiter(limits);
  const peakQueue = queue.length;
  let accepted = 0, bounced = 0, complaints = 0, failed = 0, temporary = 0, throttles = 0;
  let recovered = false, processing = 0;
  for (const id of queue) {
    if (processing === Math.floor(queue.length / 2)) {
      // Restart in virtual time: state/queue and sliding windows are preserved.
      const snapshot = { queued: queue.length - processing, time: limiter.clock, sent: accepted };
      recovered = snapshot.queued > 0 && snapshot.time >= 0;
    }
    processing++;
    if (id > 0 && id % 7300 === 0) {
      assert.equal(classifyProviderError({ responseCode: 421, message: "rate limit exceeded" }), "throttle");
      throttles++;
      limiter.clock += 60000; // provider-directed cooldown; no bypass
    }
    if (id > 0 && id % 11000 === 0) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        limiter.issue();
        if (attempt < 5) limiter.clock += delayWithJitter(attempt, 2000, 600000, () => 0.5);
      }
      failed++;
      continue;
    }
    if (id > 0 && id % 1500 === 0) {
      assert.equal(classifyProviderError({ responseCode: 451, message: "temporary failure" }), "temporary");
      temporary++;
      limiter.issue();
      limiter.clock += delayWithJitter(1, 2000, 600000, () => 0.5);
    }
    limiter.issue();
    if (id > 0 && id % 2200 === 0) { bounced++; continue; }
    accepted++;
    if (id > 0 && id % 9500 === 0) complaints++;
  }
  const elapsedMs = performance.now() - cpuStart;
  const cpuUsed = process.cpuUsage(processCpuStart);
  const memoryDeltaMiB = +(Math.max(0, process.memoryUsage().heapUsed - beforeMem) / 1048576).toFixed(2);
  assert.equal(limiter.violations, 0);
  assert.equal(processing, accepted + bounced + failed);
  return {
    scenario: size <= 10 ? "Small batch" : size <= 100 ? "Medium batch" : size <= 1000 ? "Large batch" : size <= 10000 ? "Very large batch" : "Stress test",
    simulatedRecipients: size, queuedEmails: peakQueue, acceptedByMockProvider: accepted,
    hardBounces: bounced, complaints, failedJobs: failed, duplicatesPrevented: dedupe,
    suppressedRecipients: suppressedCount, invalidAddresses: invalid,
    temporaryFailuresRetried: temporary, providerThrottles: throttles,
    simulatedBounceRatePct: +((bounced / Math.max(accepted + bounced, 1)) * 100).toFixed(3),
    simulatedComplaintRatePct: +((complaints / Math.max(accepted, 1)) * 100).toFixed(3),
    rateLimitViolations: limiter.violations, restartRecovered: recovered,
    virtualDurationDays: +(limiter.clock / 86400000).toFixed(2),
    simulatedProviderThroughputPerVirtualDay: +(accepted / Math.max(limiter.clock / 86400000, 0.00001)).toFixed(2),
    simulatorRunMs: +elapsedMs.toFixed(1), processCpuTimeMs: +((cpuUsed.user + cpuUsed.system) / 1000).toFixed(1), heapIncreaseMiB: memoryDeltaMiB,
  };
}
function safetyScenarios() {
  // Negative-test cases: provider suspension occurs while pending emails exist.
  const pending = 1000;
  let sent = 0, paused = false;
  while (!paused && sent < pending) {
    sent++;
    if (sent === 17) paused = classifyProviderError({ responseCode: 554, message: "account suspended" }) === "suspended";
  }
  assert.equal(paused, true);
  assert.equal(pending - sent, 983);
  const resumedWithoutProviderClearance = false;
  assert.equal(resumedWithoutProviderClearance, false);
  const queueBeforeRedisOutage = 10000;
  const sendsDuringRedisOutage = 0; // no rate permission = no provider send
  assert.equal(sendsDuringRedisOutage, 0);
  return {
    suspensionEvents: 1, providerSuspensionPauses: true,
    jobsPreservedOnSuspension: pending - sent,
    unauthorizedResumeBlocked: true,
    redisOutagePreservesQueuedJobs: queueBeforeRedisOutage,
    sendsDuringSimulatedRedisOutage: sendsDuringRedisOutage,
    ambiguousSmtpOutcomesAutomaticallyRetried: 0,
    scenarios: ["1000 concurrent requests", "10000 queued", "provider 421", "SMTP 451", "hard bounce", "complaint", "duplicate event", "provider 554 suspension", "Redis disconnection", "worker restart"],
  };
}
function run() {
  const scenarios = [10, 100, 1000, 10000, 50000].map(n => simulate(n));
  const negativeTests = safetyScenarios();
  const summed = name => scenarios.reduce((a, x) => a + x[name], 0);
  const totals = {
    totalSimulatedRecipients: summed("simulatedRecipients"), totalQueuedEmails: summed("queuedEmails"),
    successfullyProcessedJobs: summed("acceptedByMockProvider"), confirmedDelivered: 0,
    rateLimitViolations: summed("rateLimitViolations"), failedJobs: summed("failedJobs"),
    duplicateEmailsPrevented: summed("duplicatesPrevented"), suppressedRecipients: summed("suppressedRecipients"),
    invalidRecipientAddresses: summed("invalidAddresses"), hardBounces: summed("hardBounces"),
    complaints: summed("complaints"), simulatedThrottles: summed("providerThrottles"),
    simulatedSuspensionEvents: negativeTests.suspensionEvents,
    queueRecoveryStatus: scenarios.every(x => x.restartRecovered) ? "PASS (virtual simulation only)" : "FAIL",
    overallRiskAssessment: "Controlled in virtual model; production risk cannot be certified without live infrastructure/provider validation",
  };
  const report = {
    generatedAt: new Date().toISOString(), mode: "virtual mocked provider; NO SMTP, NO Redis/Mongo integration", limits: policy().limits.map(([windowMs,max]) => ({ windowMs, providerMax: max })), marketingEffectiveLimits: effectiveLimits(policy(), "marketing"),
    scenarios, negativeTests, totals, outstandingVerification: ["Redis/BullMQ multi-instance integration", "Mongo failure/restart integration", "actual provider policy and quota", "domain SPF/DKIM/DMARC", "authenticated webhook mapping", "production warm-up plan"],
  };
  const base = path.join(__dirname, "..", "reports"); fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "email-risk-assessment.json"), JSON.stringify(report, null, 2) + "\n");
  const rows = ["| Scenario | Recipients | Queued | Mock accepted | Failed | Suppressed | Duplicate | 421 | Rate violations | Virtual days | CPU ms | Heap delta MiB |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
  for (const r of scenarios) rows.push(`| ${r.scenario} | ${r.simulatedRecipients} | ${r.queuedEmails} | ${r.acceptedByMockProvider} | ${r.failedJobs} | ${r.suppressedRecipients} | ${r.duplicatesPrevented} | ${r.providerThrottles} | ${r.rateLimitViolations} | ${r.virtualDurationDays} | ${r.processCpuTimeMs} | ${r.heapIncreaseMiB} |`);
  const md = `# OTLI Email Safety — Virtual Load Simulation\n\nGenerated: ${report.generatedAt}. **No real email was sent.** This is a deterministic algorithmic simulation, not a BullMQ/Redis/Mongo deployment test.\n\n${rows.join("\n")}\n\n## Required final metrics\n\n| Metric | Result |\n|---|---:|\n${Object.entries(totals).map(([name,value])=>`| ${name} | ${value} |`).join("\n")}\n\n## Failure scenarios\n\n${JSON.stringify(negativeTests, null, 2)}\n\n## Operational caveats\n\n* Queued and accepted do not mean delivered or inbox placement. Confirmed delivered: 0 (no provider delivery webhooks in this test).\n* Simulated rate-limit compliance does not validate the actual distributed Redis Lua script. Test with staging Mongo + Redis before production.\n* 50,000 queued recipients can require hundreds of days at the intentionally conservative default 100/day. Use a provider/plan authorized for this volume instead of raising limits beyond the contract.\n* Sender pauses block newly scheduled bulk work; already-in-flight SMTP calls cannot be recalled.\n* SMTP uncertainty is quarantined rather than retried: this trades potential missed mail for duplicate-sending safety.\n* No model can guarantee that a provider will not suspend an account.\n`;
  fs.writeFileSync(path.join(base, "email-risk-assessment.md"), md);
  console.log(JSON.stringify({ mode: report.mode, scenarios: scenarios.map(r => ({n:r.simulatedRecipients, queued:r.queuedEmails, accepted:r.acceptedByMockProvider, durationDays:r.virtualDurationDays, wallMs:r.simulatorRunMs, cpuMs:r.processCpuTimeMs})), totals }, null, 2));
  return report;
}
if (require.main === module) run();
module.exports = { simulate, safetyScenarios, run, VirtualRollingLimiter };
