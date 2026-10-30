// Vitest suite; run after npm install. No Redis, Mongo or SMTP needed.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { policy, effectiveLimits, classifyProviderError, normalizeEmail, delayWithJitter } = require("../services/emailPolicy.js");
const { simulate, safetyScenarios } = require("../scripts/simulateEmailLoad.js");
describe("OTLI email safety policy and mocked load", () => {
  it("rejects invalid recipients", () => {
    expect(normalizeEmail("test@example.com")).toBe("test@example.com");
    for (const invalid of ["no-at-sign", "evil@example.com\r\nBcc:bad@example.com", "a@@b.com"]) expect(normalizeEmail(invalid)).toBeNull();
  });
  it("distinguishes throttling, auth, suspension, permanent and unknown", () => {
    expect(classifyProviderError({ responseCode: 421, message: "rate limit" })).toBe("throttle");
    expect(classifyProviderError({ responseCode: 451 })).toBe("temporary");
    expect(classifyProviderError({ responseCode: 535 })).toBe("auth");
    expect(classifyProviderError({ responseCode: 554, message: "account suspended" })).toBe("suspended");
    expect(classifyProviderError({ code: "ETIMEDOUT" })).toBe("uncertain");
  });
  it("uses bounded exponential backoff with jitter", () => {
    expect(delayWithJitter(2, 2000, 600000, () => 0.5)).toBe(3000);
  });
  it.each([10,100,1000,10000,50000])("models %i users with zero rate violations", count => {
    const result = simulate(count, effectiveLimits(policy(), "marketing"));
    expect(result.rateLimitViolations).toBe(0);
    expect(result.restartRecovered).toBe(true);
    expect(result.queuedEmails).toBe(result.acceptedByMockProvider+result.hardBounces+result.failedJobs);
  });
  it("simulates suspension and disconnection as hard stops",()=>{
    expect(safetyScenarios()).toMatchObject({providerSuspensionPauses:true,unauthorizedResumeBlocked:true,sendsDuringSimulatedRedisOutage:0});
  });
});
