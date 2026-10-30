# OTLI Email Safety — Virtual Load Simulation

Generated: 2026-10-30T03:12:46.198Z. **No real email was sent.** This is a deterministic algorithmic simulation, not a BullMQ/Redis/Mongo deployment test.

| Scenario | Recipients | Queued | Mock accepted | Failed | Suppressed | Duplicate | 421 | Rate violations | Virtual days | CPU ms | Heap delta MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Small batch | 10 | 9 | 9 | 0 | 0 | 0 | 0 | 0 | 0 | 0.7 | 0.04 |
| Medium batch | 100 | 99 | 99 | 0 | 0 | 1 | 0 | 0 | 1 | 0.5 | 0.2 |
| Large batch | 1000 | 990 | 990 | 0 | 5 | 18 | 0 | 0 | 12 | 5.3 | 0 |
| Very large batch | 10000 | 9902 | 9898 | 0 | 50 | 188 | 1 | 0 | 123.05 | 32.9 | 3.3 |
| Stress test | 50000 | 49511 | 49489 | 4 | 252 | 935 | 6 | 0 | 619.01 | 130.1 | 3.39 |

## Required final metrics

| Metric | Result |
|---|---:|
| totalSimulatedRecipients | 61110 |
| totalQueuedEmails | 60511 |
| successfullyProcessedJobs | 60485 |
| confirmedDelivered | 0 |
| rateLimitViolations | 0 |
| failedJobs | 4 |
| duplicateEmailsPrevented | 1142 |
| suppressedRecipients | 307 |
| invalidRecipientAddresses | 292 |
| hardBounces | 22 |
| complaints | 6 |
| simulatedThrottles | 7 |
| simulatedSuspensionEvents | 1 |
| queueRecoveryStatus | PASS (virtual simulation only) |
| overallRiskAssessment | Controlled in virtual model; production risk cannot be certified without live infrastructure/provider validation |

## Failure scenarios

{
  "suspensionEvents": 1,
  "providerSuspensionPauses": true,
  "jobsPreservedOnSuspension": 983,
  "unauthorizedResumeBlocked": true,
  "redisOutagePreservesQueuedJobs": 10000,
  "sendsDuringSimulatedRedisOutage": 0,
  "ambiguousSmtpOutcomesAutomaticallyRetried": 0,
  "scenarios": [
    "1000 concurrent requests",
    "10000 queued",
    "provider 421",
    "SMTP 451",
    "hard bounce",
    "complaint",
    "duplicate event",
    "provider 554 suspension",
    "Redis disconnection",
    "worker restart"
  ]
}

## Operational caveats

* Queued and accepted do not mean delivered or inbox placement. Confirmed delivered: 0 (no provider delivery webhooks in this test).
* Simulated rate-limit compliance does not validate the actual distributed Redis Lua script. Test with staging Mongo + Redis before production.
* 50,000 queued recipients can require hundreds of days at the intentionally conservative default 100/day. Use a provider/plan authorized for this volume instead of raising limits beyond the contract.
* Sender pauses block newly scheduled bulk work; already-in-flight SMTP calls cannot be recalled.
* SMTP uncertainty is quarantined rather than retried: this trades potential missed mail for duplicate-sending safety.
* No model can guarantee that a provider will not suspend an account.
