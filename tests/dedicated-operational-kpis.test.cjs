"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAdminBookingQuery } = require("../services/adminListFilters.js");

const modelMock = (relative, defaultExport) => {
  const key = require.resolve(relative);
  require.cache[key] = {
    id: key, filename: key, loaded: true,
    exports: { __esModule: true, default: defaultExport },
  };
};
const dependencyMock = (relative, exported) => {
  const key = require.resolve(relative);
  require.cache[key] = { id: key, filename: key, loaded: true, exports: exported };
};
const mockResponse = () => ({ json(payload) { this.data = payload; return payload; } });

// Each test file runs in its own Node worker; no model or database is connected.
const Booking = { aggregate: async () => [] };
modelMock("../models/Booking.js", Booking);
modelMock("../models/PaymentType.js", { aggregate: async () => [] });
dependencyMock("../controllers/bookingController.js", {});
dependencyMock("../controllers/inventoryController.js", {});
dependencyMock("../controllers/yardController.js", {});
dependencyMock("../utils/storageOccupancy.js", { loadStorageOccupancy: async () => ({}) });
dependencyMock("../utils/localFileStorage.js", { saveUploadedFile: async () => ({}) });
dependencyMock("../socket/socket.js", { emitToAdmins: () => {} });

const { getTrackingSummary } = require("../controllers/moduleDataController.js");
const payment = require.cache[require.resolve("../models/PaymentType.js")].exports.default;
const { getPaymentTypeStats } = require("../controllers/paymentTypeController.js");

test("tracking KPI endpoint aggregates 1,426 matches without page/limit stages", async () => {
  let pipeline;
  Booking.aggregate = async (stages) => {
    pipeline = stages;
    return [{ total: 1426, active: 1050, completed: 301 }];
  };
  const params = { page: "74", limit: "10", status: "gate_in_approved", search: "ABC.*", clientId: "client-1", rateType: "international" };
  const res = mockResponse();
  await getTrackingSummary({ query: params }, res);
  assert.deepEqual(res.data.summary, { total: 1426, active: 1050, completed: 301 });
  assert.deepEqual(pipeline[0].$match, buildAdminBookingQuery(params));
  assert.equal(pipeline.some((stage) => "$skip" in stage || "$limit" in stage), false);
  assert.equal("page" in pipeline[0].$match || "limit" in pipeline[0].$match, false);
  assert.equal(pipeline[0].$match.$or[0].bookingReference.test("ABC.*"), true);
  assert.equal(pipeline[0].$match.$or[0].bookingReference.test("ABC123"), false);
});

test("tracking KPI endpoint returns zero rather than an empty/page fallback", async () => {
  Booking.aggregate = async () => [];
  const res = mockResponse();
  await getTrackingSummary({ query: { page: "3", limit: "10" } }, res);
  assert.deepEqual(res.data.summary, { total: 0, completed: 0, active: 0 });
});

test("payment type KPI endpoint counts 1,278 records, excluding cash and page size", async () => {
  let pipeline;
  payment.aggregate = async (stages) => {
    pipeline = stages;
    return [{ total: 1278, active: 1090, banks: 722, wallets: 556 }];
  };
  const res = mockResponse();
  await getPaymentTypeStats({ query: { page: "19", limit: "10" } }, res);
  assert.deepEqual(res.data.stats, { total: 1278, active: 1090, banks: 722, wallets: 556 });
  assert.deepEqual(pipeline[0], { $match: { type: { $ne: "cash" } } });
  assert.equal(pipeline.some((stage) => "$skip" in stage || "$limit" in stage), false);
});

test("payment type KPI endpoint returns zero counts on an empty collection", async () => {
  payment.aggregate = async () => [];
  const res = mockResponse();
  await getPaymentTypeStats({}, res);
  assert.deepEqual(res.data.stats, { total: 0, active: 0, banks: 0, wallets: 0 });
});
