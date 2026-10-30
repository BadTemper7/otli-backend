"use strict";

// Handles only initial MongoDB connectivity. Once connected, the MongoDB
// driver manages reconnection; Mongoose readyState gates API database routes.
// This module has no external dependencies so retry behavior is easy to test.
function createDatabaseConnector({
  connect,
  afterConnect = async () => {},
  logger = console,
  schedule = setTimeout,
  cancel = clearTimeout,
  random = Math.random,
  minDelayMs = 2000,
  maxDelayMs = 30000,
}) {
  if (typeof connect !== "function") throw new TypeError("connect is required");
  let started = false;
  let stopped = false;
  let connecting = false;
  let failures = 0;
  let timer = null;

  const attempt = async () => {
    if (stopped || connecting) return;
    connecting = true;
    try {
      await connect();
      failures = 0;
      logger.info("[database] Initial connection established");
      try {
        await afterConnect();
      } catch (error) {
        logger.warn(`[database] Maintenance skipped type=${error?.name || "Error"}`);
      }
    } catch (error) {
      failures += 1;
      const exponential = Math.min(maxDelayMs, minDelayMs * 2 ** Math.min(12, failures - 1));
      const delayMs = Math.floor(exponential * (0.8 + 0.2 * Math.max(0, Math.min(1, random()))));
      logger.warn(`[database] Connection attempt failed type=${error?.name || "Error"} retryMs=${delayMs}`);
      if (!stopped) {
        timer = schedule(() => {
          timer = null;
          void attempt();
        }, delayMs);
      }
    } finally {
      connecting = false;
    }
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      void attempt();
    },
    stop() {
      stopped = true;
      if (timer !== null) cancel(timer);
      timer = null;
    },
    getState() {
      return { started, stopped, connecting, failures, retryScheduled: timer !== null };
    },
  };
}

module.exports = { createDatabaseConnector };
