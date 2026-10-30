"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { BOOKING_SUMMARY_KEYS, bookingSummaryPipeline, normalizeBookingSummary, yardBookingPipeline, summarizeYardBookingGroups } = require("../utils/adminMetrics.js");

const extract = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");

test("one summary aggregation replaces eleven independent count queries and keeps all known fields", () => {
  const pipeline = bookingSummaryPipeline();
  assert.equal(pipeline.length, 1);
  assert.ok(pipeline[0].$group);
  assert.equal(Object.keys(pipeline[0].$group).length, BOOKING_SUMMARY_KEYS.length + 1);
  assert.deepEqual(pipeline[0].$group.paymentReview.$sum.$cond[0].$eq, ["$billingStatus", "payment_under_review"]);
  assert.deepEqual(pipeline[0].$group.gateOutRequested.$sum.$cond[0].$eq, ["$status", "gate_out_requested"]);
  assert.deepEqual(normalizeBookingSummary({ total: 200, paid: 25 }), {
    total: 200, pending: 0, approved: 0, gateIn: 0, stored: 0,
    gateOutRequested: 0, gateOutReversalRequested: 0, completed: 0,
    unpaid: 0, paymentReview: 0, paid: 25,
  });
});

test("Analytics aggregation keeps every filter and returns bounded group rows", () => {
  const match = { status: { $in: ["stored_in_assigned_area"] }, rateType: "local" };
  const pipeline = yardBookingPipeline(match);
  assert.deepEqual(pipeline[0].$match, match);
  assert.equal(pipeline[1].$group.count.$sum, 1);
  assert.equal(pipeline[1].$group._id.recordSource, "$recordSource");
});

test("Analytic groups produce same 20ft/40ft, TEU/FEU, local/international counts", () => {
  const summary = summarizeYardBookingGroups([
    { _id: { containerSize: 20, containerLoadStatus: "empty", rateType: "local", recordSource: "client_booking" }, count: 12000 },
    { _id: { containerSize: 40, containerLoadStatus: "laden", rateType: "international", recordSource: "legacy_migration" }, count: 15000 },
    { _id: { containerSize: 40, containerLoadStatus: "empty", rateType: "local", recordSource: "client_booking" }, count: 23000 },
  ]);
  assert.equal(summary.totalContainersInYard, 50000);
  assert.equal(summary.totalTeu, 88000);
  assert.equal(summary.totalFeu, 44000);
  assert.equal(summary.empty.total, 35000);
  assert.equal(summary.empty[20], 12000);
  assert.equal(summary.international[40], 15000);
  assert.equal(summary.legacyContainers, 15000);
});

test("storage monitoring data routes require inventory view permission", () => {
  const source = extract("routes/adminRoutes.js");
  for (const uri of ["/storage-monitoring/containers", "/storage-monitoring/areas", "/storage-monitoring/areas/:areaId/slot-map", "/storage-monitoring/areas/:areaId/blocks"]) {
    const index = source.indexOf(`"${uri}"`);
    assert.ok(index >= 0, uri);
    assert.match(source.slice(index, index + 180), /requirePermission\)\("inventory", "view"\)/);
  }
});

test("payment-type reads preserve automatic Cash creation with a single-flight guard", () => {
  const source = extract("controllers/paymentTypeController.js");
  assert.match(source, /let cashEnsured = false/);
  assert.match(source, /if \(cashEnsurePromise\) return cashEnsurePromise/);
  assert.match(source, /cashEnsured = true/);
  for (const name of ["listPaymentTypes", "listActivePaymentTypes"]) {
    const start = source.indexOf(`const ${name} = async`);
    const end = source.indexOf(`exports.${name} =`, start);
    const body = source.slice(start, end);
    assert.match(body, /await ensureDefaultCashPaymentType\(\)/);
    assert.match(body, /\.lean\(\)/);
  }
});

test("booking module table can return without waiting for summary; legacy response remains compatible", async () => {
  const source = extract("controllers/moduleDataController.js");
  const calls = { list: 0, summary: 0 };
  const complete = (res, body) => res.json(body);
  const stub = {
    listAdminBookings: async (_req, res) => { calls.list += 1; return complete(res, { bookings: [{ id: "b" }], pagination: { page: 1, total: 1 } }); },
    getBookingSummary: async (_req, res) => { calls.summary += 1; return complete(res, { summary: { total: 1, unpaid: 1 } }); },
  };
  const mockRequire = (id) => {
    if (id.endsWith("/bookingController.js")) return stub;
    if (id.endsWith("/inventoryController.js")) return {};
    if (id.endsWith("/yardController.js")) return {};
    if (id.endsWith("/storageOccupancy.js")) return {};
    throw new Error("Unexpected module: " + id);
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { require: mockRequire, module, exports: module.exports, Promise, console }, { filename: "moduleDataController.js" });
  const respond = () => ({ json(data) { this.body = data; return data; } });
  const listRes = respond();
  await module.exports.getBookingModuleData({ query: { includeSummary: "false" } }, listRes);
  assert.equal(calls.list, 1);
  assert.equal(calls.summary, 0);
  assert.equal(listRes.body.bookings.length, 1);
  assert.equal(Object.hasOwn(listRes.body, "summary"), false);
  const summaryRes = respond();
  await module.exports.getBookingModuleData({ query: { summaryOnly: "true" } }, summaryRes);
  assert.equal(calls.list, 1);
  assert.equal(calls.summary, 1);
  assert.equal(summaryRes.body.summary.total, 1);
  const legacyRes = respond();
  await module.exports.getBookingModuleData({ query: {} }, legacyRes);
  assert.equal(calls.list, 2);
  assert.equal(calls.summary, 2);
  assert.equal(legacyRes.body.summary.unpaid, 1);
});


test("read-only block metadata endpoint never creates a default yard block", () => {
  const source = extract("controllers/storageMonitoringController.js");
  const start = source.indexOf("const getStorageYardBlocks = async");
  const end = source.indexOf("const getStorageYardSlotMap", start);
  const handler = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(handler, /YardBlock\.find\(\{ area: areaId \}\)/);
  assert.doesNotMatch(handler, /\.create\(|createDefaultBlock/);
});
