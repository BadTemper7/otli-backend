"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createDatabaseAvailability } = require("../middleware/databaseAvailability.js");
const { createApiDiagnostics } = require("../middleware/apiDiagnostics.js");
const { createApiErrorHandler, isMongoConnectivityError } = require("../middleware/apiErrorResponse.js");

const makeResponse = () => {
  const res = new EventEmitter();
  res.headers = {};
  res.statusCode = 200;
  res.writableEnded = false;
  res.setHeader = (name, value) => { res.headers[name] = value; return res; };
  res.status = (status) => { res.statusCode = status; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

test("database guard passes when connected and leaves test route available", () => {
  let nextCalls = 0;
  const middleware = createDatabaseAvailability(() => 1);
  middleware({ path: "/bookings" }, makeResponse(), () => nextCalls++);
  createDatabaseAvailability(() => 0)({ path: "/test" }, makeResponse(), () => nextCalls++);
  assert.equal(nextCalls, 2);
});

test("database guard fails fast when disconnected, with retry hint", () => {
  for (const state of [0, 2, 3]) {
    const res = makeResponse();
    createDatabaseAvailability(() => state)({ path: "/bookings" }, res, () => { throw new Error("Should not pass"); });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, "DATABASE_UNAVAILABLE");
    assert.equal(res.headers["Retry-After"], "5");
  }
});

test("database exceptions are sanitized and identified as 503", () => {
  const err = Object.assign(new Error("mongodb+srv://user:secret@host"), { name: "MongoServerSelectionError" });
  const res = makeResponse();
  createApiErrorHandler({ logger: { error() {} } })(err, { apiRequestId: "test" }, res, () => {});
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "DATABASE_UNAVAILABLE");
  assert.equal(res.body.error, "Something went wrong!");
  assert.ok(!JSON.stringify(res.body).includes("secret"));
});

test("non-database exceptions still produce safe errors", () => {
  assert.equal(isMongoConnectivityError(Object.assign(new Error("not duplicate"), { name: "MongoServerError", code: 11000 })), false);
  const res = makeResponse();
  createApiErrorHandler({ logger: { error() {} } })(new Error("JWT_SECRET=do-not-expose"), {}, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.ok(!JSON.stringify(res.body).includes("do-not-expose"));
});

test("upload errors use existing handlers and report readable status", () => {
  const res = makeResponse();
  const err = Object.assign(new Error("LIMIT_FILE_SIZE"), { name: "MulterError", code: "LIMIT_FILE_SIZE" });
  createApiErrorHandler()(err, {}, res, () => {});
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.code, "UPLOAD_TOO_LARGE");
});

test("successful requests keep existing responses and do not log PII", () => {
  const logs = [];
  const res = makeResponse();
  const req = { method: "GET", path: "/users/private@example.test", baseUrl: "/api/admin", route: { path: "/users/:id" } };
  let called = false;
  createApiDiagnostics({ getDatabaseState: () => 1, logger: { info: (value) => logs.push(value), warn: (value) => logs.push(value) }, slowMs: 0 })(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.match(res.headers["X-Request-ID"], /^[a-f0-9-]{36}$/);
  res.writableEnded = true;
  res.emit("finish");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\/api\/admin\/users\/:id/);
  assert.ok(!logs[0].includes("private@example.test"));
});

test("disconnected clients are logged without request bodies", () => {
  const logs = [];
  const req = { method: "POST", path: "/register", body: { password: "NEVER_LOG" }, baseUrl: "/api/auth", route: { path: "/client/register/request-otp" } };
  const res = makeResponse();
  createApiDiagnostics({ logger: { info: () => {}, warn: (message) => logs.push(message) }, slowMs: 999999 })(req, res, () => {});
  res.emit("close");
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes("NEVER_LOG"));
});

test("database pool and selection timeouts are bounded in the server source", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /serverSelectionTimeoutMS:\s*10000/);
  assert.match(server, /waitQueueTimeoutMS:\s*5000/);
  assert.match(server, /createDatabaseAvailability/);
  assert.match(server, /createApiDiagnostics/);
  assert.match(server, /createApiErrorHandler/);
});

test("database ping succeeds and reports safe timing without private data", async () => {
  const { probeDatabase } = require("../utils/databaseHealth.js");
  const connection = { readyState: 1, db: { admin: () => ({ ping: async () => ({ ok: 1 }) }) } };
  const result = await probeDatabase(connection);
  assert.equal(result.healthy, true);
  assert.equal(result.mongodb, "reachable");
  assert.ok(result.latencyMs >= 0);
  assert.equal(JSON.stringify(result).includes("mongodb+srv"), false);
});

test("database ping fails quickly for disconnected state", async () => {
  const { probeDatabase } = require("../utils/databaseHealth.js");
  const result = await probeDatabase({ readyState: 0 });
  assert.equal(result.healthy, false);
  assert.equal(result.mongodb, "disconnected");
});

test("database ping enforces a reply deadline on a stuck driver", async () => {
  const { probeDatabase } = require("../utils/databaseHealth.js");
  let started = false;
  const connection = { readyState: 1, db: { admin: () => ({ ping: () => { started = true; return new Promise(() => {}); } }) } };
  const result = await probeDatabase(connection, { timeoutMs: 5 });
  assert.equal(started, true);
  assert.equal(result.healthy, false);
  assert.equal(result.mongodb, "unresponsive");
});
