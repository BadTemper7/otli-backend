"use strict";

// A bounded, read-only DB ping used solely for troubleshooting. It has no
// access to user data, does not reveal database URLs and does not write data.
const probeDatabase = async (connection, { timeoutMs = 3000, startedAt = () => process.hrtime.bigint() } = {}) => {
  const start = startedAt();
  const latency = () => Math.round(Number(startedAt() - start) / 1e6);
  if (connection?.readyState !== 1 || !connection.db) {
    return { healthy: false, mongodb: "disconnected", latencyMs: latency() };
  }

  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Database health probe timed out."));
    }, timeoutMs);
  });
  try {
    await Promise.race([
      connection.db.admin().ping({ signal: controller.signal, maxTimeMS: timeoutMs }),
      deadline,
    ]);
    return { healthy: true, mongodb: "reachable", latencyMs: latency() };
  } catch {
    return { healthy: false, mongodb: "unresponsive", latencyMs: latency() };
  } finally {
    clearTimeout(timer);
  }
};

module.exports = { probeDatabase };
