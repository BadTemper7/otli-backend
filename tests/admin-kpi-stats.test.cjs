"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const User = { aggregate: async () => [] };
const modelFile = require.resolve("../models/User.js");
require.cache[modelFile] = { id: modelFile, filename: modelFile, loaded: true, exports: { default: User } };
const { getAdminUserStats, getClientRegistrationStats } = require("../controllers/adminStatsController.js");

const makeRes = () => ({ json(payload) { this.payload = payload; return payload; } });
const makeBucket = (status, role, count) => ({ _id: { status, role }, count });

test("User Management counts all 1,500 admin accounts independently of the 10-row table", async () => {
  let stages;
  User.aggregate = async (pipeline) => {
    stages = pipeline;
    return [
      makeBucket("active", "super_admin", 100),
      makeBucket("active", "admin", 600),
      makeBucket("active", "staff", 500),
      makeBucket("pending", "staff", 200),
      makeBucket("suspended", "admin", 100),
    ];
  };
  const res = makeRes();
  await getAdminUserStats({ query: { page: 4, limit: 10, search: "someone" } }, res);
  assert.deepEqual(res.payload.stats, { accounts: 1500, active: 1200, staff: 700 });
  assert.deepEqual(res.payload.statusOptions, ["active", "pending", "suspended"]);
  assert.deepEqual(stages[0], { $match: { userType: "admin" } });
  assert.equal(stages.some((stage) => "$skip" in stage || "$limit" in stage), false);
});

test("Client Verification groups verified/resubmitted/pending/rejected over every page", async () => {
  let stages;
  User.aggregate = async (pipeline) => {
    stages = pipeline;
    return [
      makeBucket("verified", "client", 875),
      makeBucket("active", "client", 40),
      makeBucket("pending", "client", 290),
      makeBucket("resubmitted", "client", 15),
      makeBucket("rejected", "client", 88),
      makeBucket("suspended", "client", 4),
    ];
  };
  const res = makeRes();
  await getClientRegistrationStats({ query: { page: 100, limit: 10, status: "pending" } }, res);
  assert.deepEqual(res.payload.stats, { verified: 915, pending: 305, rejected: 88 });
  assert.deepEqual(stages[0], { $match: { userType: "client" } });
  assert.equal(stages.some((stage) => "$skip" in stage || "$limit" in stage), false);
});

test("KPI endpoints keep zero counts valid when no users exist", async () => {
  User.aggregate = async () => [];
  const adminRes = makeRes();
  const clientRes = makeRes();
  await getAdminUserStats({}, adminRes);
  await getClientRegistrationStats({}, clientRes);
  assert.deepEqual(adminRes.payload.stats, { accounts: 0, active: 0, staff: 0 });
  assert.deepEqual(clientRes.payload.stats, { verified: 0, pending: 0, rejected: 0 });
});

test("KPI API paths use the correct existing view permissions", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/adminRoutes.js"), "utf8");
  assert.match(source, /"\/users\/stats",\s*authMiddleware_js_1\.superAdminOnly/);
  assert.match(source, /"\/client-registrations\/stats",\s*\(0, authMiddleware_js_1\.requirePermission\)\("clientVerification", "view"\)/);
  assert.ok(source.indexOf('"/users/stats"') < source.indexOf('"/users/:id"'));
});
