"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const {
  getAllowedOrigins,
  isAllowedOrigin,
  normalizeOrigin,
  createCorsOptions,
} = require("../config/cors.js");

const sites = "https://onetrue.ph,https://admin.onetrue.ph,http://localhost:5173,http://localhost:5174";

function corsDecision(options, origin) {
  return new Promise((resolve, reject) => {
    options.origin(origin, (error, allowed) => {
      if (error) reject(error);
      else resolve(allowed);
    });
  });
}

test("CLIENT_ORIGINS supports both live sites and existing localhost development origins", () => {
  const origins = getAllowedOrigins(sites);
  assert.deepEqual(origins, [
    "https://onetrue.ph",
    "https://admin.onetrue.ph",
    "http://localhost:5173",
    "http://localhost:5174",
  ]);
  assert.equal(isAllowedOrigin("https://onetrue.ph", origins), true);
  assert.equal(isAllowedOrigin("https://admin.onetrue.ph", origins), true);
  assert.equal(isAllowedOrigin("http://localhost:5173", origins), true);
  assert.equal(isAllowedOrigin("http://localhost:5174", origins), true);
});

test("normalizes optional trailing slash and deduplicates entries", () => {
  assert.deepEqual(
    getAllowedOrigins("https://onetrue.ph/, https://onetrue.ph,https://ADMIN.ONETRUE.PH/"),
    ["https://onetrue.ph", "https://admin.onetrue.ph"],
  );
  assert.equal(normalizeOrigin("https://admin/onetrue.ph/"), null);
  assert.equal(normalizeOrigin("https://onetrue.ph/login"), null);
  assert.equal(normalizeOrigin("*"), null);
});

test("rejects unknown websites, malicious lookalikes, and null origins", () => {
  const origins = getAllowedOrigins(sites);
  for (const origin of [
    "https://attacker.invalid",
    "https://admin.onetrue.ph.attacker.invalid",
    "http://onetrue.ph",
    "https://admin/onetrue.ph/",
    "null",
    "https://onetrue.ph:9999",
  ]) {
    assert.equal(isAllowedOrigin(origin, origins), false, origin);
  }
});

test("CORS middleware allows both sites with credentials without wildcard", async () => {
  const options = createCorsOptions(getAllowedOrigins(sites));
  assert.equal(options.credentials, true);
  assert.equal(options.optionsSuccessStatus, 204);
  assert.ok(options.methods.includes("OPTIONS"));
  assert.ok(options.methods.includes("PATCH"));
  assert.equal(await corsDecision(options, "https://onetrue.ph"), true);
  assert.equal(await corsDecision(options, "https://admin.onetrue.ph"), true);
  assert.equal(await corsDecision(options, "https://other-site.invalid"), false);
  assert.equal(await corsDecision(options, "null"), false);
  assert.equal(await corsDecision(options, undefined), true);
});

test("Express shares CLIENT_ORIGINS with Socket.IO and avoids blanket cors()", () => {
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.ok(source.includes("app.use(cors(createCorsOptions(allowedClientOrigins)))"));
  assert.ok(source.includes("process.env.CLIENT_ORIGINS"));
  assert.equal(/app\.use\(cors\(\)\)/.test(source), false);
});

test("Socket.IO handshake permits both sites but rejects unknown WebSocket origins", async () => {
  const actualLoad = Module._load;
  let options;
  class MockSocketServer {
    constructor(_server, passedOptions) {
      options = passedOptions;
      this.engine = { on() {} };
    }
    use() {}
    on() {}
  }
  Module._load = function(request, parent, isMain) {
    if (request === "socket.io") return { Server: MockSocketServer };
    if (request === "jsonwebtoken") return { default: { verify() {} }, verify() {} };
    if (request === "../models/User.js" && parent?.filename?.endsWith("socket/socket.js")) {
      return { default: {}, findById() {} };
    }
    return actualLoad.apply(this, arguments);
  };
  let initSocket;
  try {
    ({ initSocket } = require("../socket/socket.js"));
  } finally {
    Module._load = actualLoad;
  }
  const origins = getAllowedOrigins(sites);
  initSocket({}, origins);
  assert.deepEqual(options.cors.origin, origins);
  assert.equal(options.cors.credentials, true);
  for (const [origin, expected] of [
    ["https://onetrue.ph", true],
    ["https://admin.onetrue.ph", true],
    ["https://malicious.invalid", false],
    ["null", false],
    [undefined, true],
  ]) {
    const actual = await new Promise((resolve, reject) => {
      options.allowRequest({ headers: { origin } }, (error, allow) => {
        if (error) reject(error);
        else resolve(allow);
      });
    });
    assert.equal(actual, expected);
  }
});
