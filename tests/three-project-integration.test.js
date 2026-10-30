"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createDatabaseConnector } = require("../utils/runtimeStartup.js");

const projectRoot = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(projectRoot, file), "utf8");
const quiet = { info() {}, warn() {} };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("initial MongoDB failures schedule a retry without terminating the HTTP server", async () => {
  let calls = 0;
  let timer;
  let delay;
  const worker = createDatabaseConnector({
    connect: async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("secret-in-uri"), { name: "MongoServerSelectionError" });
    },
    schedule: (fn, ms) => { timer = fn; delay = ms; return 42; },
    cancel() {},
    random: () => 0,
    logger: quiet,
  });
  worker.start();
  await flush();
  assert.equal(calls, 1);
  assert.equal(worker.getState().failures, 1);
  assert.equal(worker.getState().retryScheduled, true);
  assert.ok(delay >= 1600 && delay <= 2000);
  timer();
  await flush();
  assert.equal(calls, 2);
  assert.equal(worker.getState().failures, 0);
  assert.equal(worker.getState().retryScheduled, false);
  worker.stop();
});

test("connection retries cannot spawn simultaneous connection attempts", async () => {
  let resolve;
  let calls = 0;
  const worker = createDatabaseConnector({
    connect: () => { calls++; return new Promise((r) => { resolve = r; }); },
    logger: quiet,
  });
  worker.start();
  worker.start();
  assert.equal(calls, 1);
  resolve();
  await flush();
  worker.stop();
});

test("database maintenance errors cannot take down successful startup", async () => {
  const worker = createDatabaseConnector({
    connect: async () => {},
    afterConnect: async () => { throw new Error("index error"); },
    logger: quiet,
  });
  worker.start();
  await flush();
  assert.equal(worker.getState().failures, 0);
  worker.stop();
});

test("database startup stops scheduling retries once stopped", async () => {
  let cancelled = null;
  const worker = createDatabaseConnector({
    connect: async () => { throw new Error("offline"); },
    schedule: () => 100,
    cancel: (id) => { cancelled = id; },
    logger: quiet,
  });
  worker.start();
  await flush();
  worker.stop();
  assert.equal(cancelled, 100);
  assert.equal(worker.getState().retryScheduled, false);
});

function loadAuth({ verify, findById }) {
  const module = { exports: {} };
  const requireMock = (name) => {
    if (name === "jsonwebtoken") return { __esModule: true, default: { verify } };
    if (name === "../models/User.js") return { __esModule: true, default: { findById } };
    if (name === "../utils/permissions.js") return { normalizePermissions: () => ({}), getAllAccessPermissions: () => ({}), resolvePermissionModule: (x) => x };
    throw new Error("Unexpected import: " + name);
  };
  vm.runInNewContext(read("middleware/authMiddleware.js"), {
    module, exports: module.exports, require: requireMock,
    process: { env: { JWT_SECRET: "test-key" } },
  });
  return module.exports;
}

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
}

test("token errors remain 401 without database access", async () => {
  const auth = loadAuth({
    verify: () => { throw new Error("invalid token"); },
    findById: () => { throw new Error("should not query"); },
  });
  const res = response();
  await auth.protect({ headers: { authorization: "Bearer invalid" } }, res, () => {});
  assert.equal(res.statusCode, 401);
});

test("MongoDB errors during /auth/me pass to the 503 handler, never 401", async () => {
  const outage = Object.assign(new Error("unavailable"), { name: "MongoServerSelectionError" });
  const auth = loadAuth({ verify: () => ({ id: "u1" }), findById: async () => { throw outage; } });
  const res = response();
  let passedError;
  await auth.protect({ headers: { authorization: "Bearer valid" } }, res, (e) => { passedError = e; });
  assert.equal(passedError, outage);
  assert.equal(res.statusCode, 200);
});

test("valid tokens still authorize active users", async () => {
  const auth = loadAuth({ verify: () => ({ id: "u1" }), findById: async () => ({ userType: "admin", status: "active" }) });
  const res = response();
  let called = false;
  const req = { headers: { authorization: "Bearer valid" } };
  await auth.protect(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.user.userType, "admin");
});

test("HTTP starts before database connection and retains existing health routes", () => {
  const source = read("server.js");
  assert.ok(source.indexOf("httpServer.listen(PORT") < source.indexOf("dbConnector.start()"));
  assert.match(source, /app\.get\("\/health\/database"/);
  assert.match(source, /app\.get\("\/api\/test"/);
  assert.doesNotMatch(source, /dns\.setServers\(/);
  assert.match(source, /mongoose\.set\("bufferCommands", false\)/);
});

test("CORS exposes support request ID without allowing all production origins", () => {
  const { createCorsPolicy } = require("../config/cors.js");
  const policy = createCorsPolicy({ NODE_ENV: "production", CLIENT_ORIGINS: "https://onetrue.ph,https://admin.onetrue.ph" });
  assert.ok(policy.corsOptions.exposedHeaders.includes("X-Request-ID"));
  assert.equal(policy.isAllowedOrigin("https://unknown.invalid"), false);
  assert.equal(policy.isAllowedOrigin("https://admin.onetrue.ph"), true);
});
