"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createCorsPolicy } = require("../config/cors.js");

function originDecision(policy, origin) {
  let calls = 0;
  let decision;
  policy.corsOptions.origin(origin, (error, allowed) => {
    assert.equal(error, null);
    calls += 1;
    decision = allowed;
  });
  assert.equal(calls, 1);
  return decision;
}

test("local development allows localhost frontend origins on any port", () => {
  const policy = createCorsPolicy({ NODE_ENV: "development" });
  for (const origin of [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:4173",
    "http://127.0.0.1:5173",
    "http://[::1]:5173",
  ]) {
    assert.equal(originDecision(policy, origin), true, origin);
  }
  assert.equal(policy.isDevelopment, true);
});

test("development also permits cross-origin test tools", () => {
  const policy = createCorsPolicy({ NODE_ENV: "test" });
  assert.equal(originDecision(policy, "https://example.test"), true);
  assert.equal(originDecision(policy, "null"), true);
  assert.equal(originDecision(policy, undefined), true);
});

test("production permits the two OneTrue sites and configured localhost frontends", () => {
  const policy = createCorsPolicy({
    NODE_ENV: "production",
    CLIENT_ORIGINS: "https://admin.onetrue.ph, https://onetrue.ph, http://localhost:5173, http://localhost:5174",
  });
  for (const origin of [
    "https://onetrue.ph",
    "https://admin.onetrue.ph",
    "http://localhost:5173",
    "http://localhost:5174",
  ]) {
    assert.equal(originDecision(policy, origin), true, origin);
  }
  assert.equal(policy.isDevelopment, false);
});

test("production denies unlisted, lookalike, and malformed origins", () => {
  const policy = createCorsPolicy({
    NODE_ENV: "production",
    CLIENT_ORIGINS: "https://onetrue.ph,http://localhost:5173",
  });
  for (const origin of [
    "https://onetrue.ph.attacker.test",
    "http://onetrue.ph",
    "http://localhost:4173",
    "http://127.0.0.1:5173",
    "null",
    "file://local/example",
    "https://onetrue.ph/path",
    "https://onetrue.ph.evil.test",
  ]) {
    assert.equal(originDecision(policy, origin), false, origin);
  }
});

test("production never silently allows arbitrary origins without CLIENT_ORIGINS", () => {
  const policy = createCorsPolicy({ NODE_ENV: "production" });
  assert.equal(originDecision(policy, "https://onetrue.ph"), true);
  assert.equal(originDecision(policy, "https://admin.onetrue.ph"), true);
  assert.equal(originDecision(policy, "http://localhost:5173"), false);
  assert.equal(originDecision(policy, "https://unknown.test"), false);
  assert.equal(originDecision(policy, undefined), true);
});

test("extra Socket.IO and CORS origin lists remain supported", () => {
  const policy = createCorsPolicy({
    NODE_ENV: "production",
    SOCKET_ALLOWED_ORIGINS: "https://socket.example.test",
    CORS_ORIGINS: "https://api-client.example.test/",
  });
  assert.equal(originDecision(policy, "https://socket.example.test"), true);
  assert.equal(originDecision(policy, "https://api-client.example.test"), true);
});

test("credentialed requests and preflight requests have matching CORS options", () => {
  const options = createCorsPolicy({ NODE_ENV: "development" }).corsOptions;
  assert.equal(options.credentials, true);
  assert.equal(options.optionsSuccessStatus, 204);
  assert.ok(options.methods.includes("OPTIONS"));
  assert.ok(options.methods.includes("POST"));
  assert.ok(options.methods.includes("PATCH"));
});

test("server and socket transport use the same policy object", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const socketSource = fs.readFileSync(path.join(__dirname, "..", "socket", "socket.js"), "utf8");
  assert.match(serverSource, /app\.use\(cors\(corsPolicy\.corsOptions\)\)/);
  assert.match(serverSource, /initSocket\(httpServer, corsPolicy\.corsOptions\)/);
  assert.match(socketSource, /cors:\s*corsOptions/);
});


test("missing NODE_ENV fails closed rather than exposing a hosted deployment", () => {
  const policy = createCorsPolicy({});
  assert.equal(policy.isDevelopment, false);
  assert.equal(originDecision(policy, "https://unknown.test"), false);
  assert.equal(originDecision(policy, "https://onetrue.ph"), true);
});
