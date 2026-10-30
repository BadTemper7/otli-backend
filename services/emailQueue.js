"use strict";
const { Queue, Worker } = require("bullmq");
const Redis = require("ioredis");
const { policy, delayWithJitter } = require("./emailPolicy.js");
const NAMES = { transactional: "otli-email-transactional", marketing: "otli-email-marketing", campaigns: "otli-email-campaigns" };
const prefix = () => process.env.EMAIL_REDIS_PREFIX || "otli:email";
let connection;
const queues = {};
const workers = [];
function makeConnection() {
  if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required to use the safe email queue");
  const c = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null, connectTimeout: 10000, retryStrategy: attempt => Math.min(30000, attempt * 1000) });
  c.on("error", () => { /* Avoid leaking Redis URLs or credentials in logs. */ });
  return c;
}
function redis() { if (!connection) connection = makeConnection(); return connection; }
function queue(category) {
  if (!NAMES[category]) throw new Error("Unknown email queue category");
  if (!queues[category]) queues[category] = new Queue(NAMES[category], { connection: redis(), prefix: prefix() });
  return queues[category];
}
function newWorker(category, processor) {
  const p = policy();
  const worker = new Worker(NAMES[category], processor, {
    connection: makeConnection(), prefix: prefix(),
    concurrency: category === "campaigns" ? 1 : p.workerConcurrency,
    limiter: { max: 1, duration: 1000 },
    settings: {
      backoffStrategy: attempts => delayWithJitter(attempts, p.retryBaseMs, p.retryMaxMs),
    },
  });
  worker.on("error", () => { /* Report worker connectivity through /email/monitor, no credentials. */ });
  workers.push(worker);
  return worker;
}
async function close() {
  await Promise.allSettled(workers.map(w => w.close()));
  await Promise.allSettled(Object.values(queues).map(q => q.close()));
  if (connection) await connection.quit();
}
module.exports = { redis, queue, newWorker, close, prefix };
