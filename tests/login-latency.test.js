"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "controllers", "authController.js"), "utf8");

function loadLogin({ user = null, selectedMs = 1500, passwordMatches = true } = {}) {
  const logs = [];
  const results = [];
  let ticks = 0n;
  const userStub = user || {
    _id: "mock-user-id",
    name: "Secret Admin",
    email: "private@example.test",
    userType: "admin",
    status: "active",
    role: "admin",
    permissions: {},
    matchPassword: async () => passwordMatches,
  };
  const mockedRequire = (name) => {
    if (name === "../models/User.js") {
      return { __esModule: true, default: {
        findOne() {
          return { select: async () => userStub };
        },
      } };
    }
    if (name === "../utils/permissions.js") {
      return { getAllAccessPermissions: () => ({}), normalizePermissions: () => ({}) };
    }
    if (name === "../utils/jwt.js") return { generateToken: () => "mocked-jwt" };
    return {};
  };
  const exports = {};
  vm.runInNewContext(source, {
    require: mockedRequire,
    exports,
    console: { warn: (message) => logs.push(message), error: () => {} },
    process: { hrtime: { bigint: () => { ticks += BigInt(selectedMs) * 1000000n; return ticks; } }, env: {} },
    Buffer,
  }, { filename: "controllers/authController.js" });
  const makeRes = () => ({
    status(code) { results.push({ code }); return this; },
    json(data) { results.push({ data }); return data; },
  });
  return { login: exports.login, makeRes, logs, results };
}

test("login preserves response and adds non-sensitive timing for slow requests", async () => {
  const app = loadLogin();
  await app.login({ body: { email: "private@example.test", password: "mySecret", loginType: "admin" }, apiRequestId: "req-1" }, app.makeRes());
  assert.equal(app.results.at(-1).data.success, true);
  assert.equal(app.results.at(-1).data.token, "mocked-jwt");
  assert.equal(app.results.at(-1).data.user.userType, "admin");
  assert.match(app.logs[0], /\[auth\] slow login requestId=req-1 lookupMs=\d+ verifyMs=\d+ totalMs=\d+/);
  assert.doesNotMatch(app.logs[0], /private@example\.test|mySecret|mocked-jwt/);
});

test("invalid password remains a 401 and never logs credentials", async () => {
  const app = loadLogin({ passwordMatches: false });
  await app.login({ body: { email: "private@example.test", password: "mySecret", loginType: "admin" } }, app.makeRes());
  assert.ok(app.results.find((r) => r.code === 401));
  assert.match(app.results.at(-1).data.message, /Invalid email or password/);
  assert.doesNotMatch(app.logs.join("\n"), /private@example\.test|mySecret/);
});

test("wrong login type remains a 403 and does not skip account restrictions", async () => {
  const app = loadLogin();
  await app.login({ body: { email: "private@example.test", password: "mySecret", loginType: "client" } }, app.makeRes());
  assert.ok(app.results.find((r) => r.code === 403));
  assert.equal(app.results.at(-1).data.success, false);
});

test("missing credentials remain a 400", async () => {
  const app = loadLogin();
  await app.login({ body: { email: "", password: "" } }, app.makeRes());
  assert.ok(app.results.find((r) => r.code === 400));
});
