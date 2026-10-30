"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeEmail, classifyProviderError, delayWithJitter, policy } = require("../services/emailPolicy.js");
const { simulate, safetyScenarios, VirtualRollingLimiter } = require("../scripts/simulateEmailLoad.js");
test("validation rejects malformed/header-injection emails", () => {
  assert.equal(normalizeEmail("user@example.com"), "user@example.com");
  for (const input of ["", "bad", "a@@example.com", "user@-example.com", "user@example.com\\r\\nBCC:evil@test.com", "user@", "a@example..com", ".foo@example.com", "foo..bar@example.com", "bad!domain@example..com"]) assert.equal(normalizeEmail(input), null, input);
});
test("SMTP classifications pause/retry/unknown are distinct", () => {
  for (const [err,expected] of [[{responseCode:421, message:"too many messages"},"throttle"], [{responseCode:550, message:"daily sending limit exceeded"},"throttle"], [{responseCode:451, message:"temporary"},"temporary"], [{responseCode:535},"auth"], [{responseCode:550, message:"5.1.1 no such mailbox"},"hard_bounce"], [{responseCode:554, message:"account suspended"},"suspended"], [{code:"ECONNRESET"},"uncertain"], [{code:"ECONNREFUSED"},"temporary"]]) assert.equal(classifyProviderError(err), expected);
});
test("retry delay is exponential and jittered", () => {
  assert.equal(delayWithJitter(1, 2000, 600000, () => 0), 1000);
  assert.equal(delayWithJitter(2, 2000, 600000, () => 1), 4000);
  assert.equal(delayWithJitter(30, 2000, 600000, () => 1), 600000);
});
test("single shared virtual rate bucket enforces all four windows", () => {
  const l = new VirtualRollingLimiter(policy().limits);
  const stamps = Array.from({length:1200},()=>l.issue());
  for (const [ms,max] of policy().limits) {
    for (let i=0;i<stamps.length;i+=Math.max(1, Math.floor(stamps.length/90))) {
      const count = stamps.filter(t=>t>stamps[i]-ms && t<=stamps[i]).length;
      assert.ok(count<=max, `window ${ms} exceeded: ${count}>${max}`);
    }
  }
  assert.equal(l.violations,0);
});
test("10,100,1000,10000,50000 mocked traffic, 0 external mail", () => {
  for (const n of [10,100,1000,10000,50000]) {
    const result = simulate(n);
    assert.equal(result.simulatedRecipients,n);
    assert.equal(result.rateLimitViolations,0);
    assert.equal(result.acceptedByMockProvider+result.hardBounces+result.failedJobs,result.queuedEmails);
    assert.equal(result.restartRecovered,true);
    if (n>=1000) assert.ok(result.duplicatesPrevented>0);
  }
});
test("suspension and Redis outage halt further sends in modeled scenarios",()=>{
  const result=safetyScenarios();
  assert.equal(result.providerSuspensionPauses,true);
  assert.equal(result.unauthorizedResumeBlocked,true);
  assert.equal(result.sendsDuringSimulatedRedisOutage,0);
  assert.equal(result.ambiguousSmtpOutcomesAutomaticallyRetried,0);
});
