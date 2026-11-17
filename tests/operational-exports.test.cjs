"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAdminBookingQuery, buildInventoryQueries } = require("../services/adminListFilters.js");
// Isolated controller tests: the deployment dependencies are not required.
// Replace only the model imports with in-memory query stubs before requiring
// the controller. This prevents any live database access.
const mockModels = Object.fromEntries(["Booking", "InventoryContainer", "User", "YardArea"].map((name) => [name, {}]));
for (const [name, model] of Object.entries(mockModels)) {
  const filepath = require.resolve(`../models/${name}.js`);
  require.cache[filepath] = { id: filepath, filename: filepath, loaded: true, exports: { default: model } };
}
const Booking = mockModels.Booking;
const InventoryContainer = mockModels.InventoryContainer;
const { exportTrackingCsv, exportInventoryCsv, trackingRow, inventoryBookingRow } = require("../controllers/operationalExportController.js");

const createResponse = () => ({
  chunks: [], headers: {}, destroyed: false, writableEnded: false, headersSent: false,
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  write(chunk) { this.headersSent = true; this.chunks.push(String(chunk)); return true; },
  end() { this.writableEnded = true; },
  destroy(err) { this.destroyed = true; throw err; },
  get body() { return this.chunks.join(""); },
});
const fakeFind = (rows, capture) => (query) => {
  capture.push(query);
  return {
    select() { return this; }, populate() { return this; }, sort() { return this; }, lean() { return this; },
    cursor({ batchSize }) {
      assert.equal(batchSize, 100);
      return {
        async *[Symbol.asyncIterator]() { for (const row of rows) yield row; },
        async close() {},
      };
    },
  };
};
const fakeBooking = (index) => ({
  bookingReference: `BK-${index}`, client: { name: "Sample Client", companyName: "ABC Logistics", email: "office@example.com" },
  containerNumber: `CON${index}`, containerSize: 40, containerType: "dry",
  containerLoadStatus: "empty", rateType: "local", status: "gate_in_approved",
  billingStatus: "unpaid", recordSource: "client_booking", billingTotal: 250,
  assignedArea: { name: "Area A" }, assignedBlock: { name: "Block A" }, assignedSlotNumber: "B1-R1-T1",
  assignedBay: 1, assignedRow: 1, assignedTier: 1,
  gateInApprovedAt: new Date("2026-11-01T00:00:00Z"), createdAt: new Date("2026-11-01T00:00:00Z"),
});

test("booking table and tracking export share all filters, ignore page, and escape regex searches", () => {
  const query = buildAdminBookingQuery({ status: "gate_in_approved,stored_in_assigned_area", clientId: "id1", search: "X.*(2)", billingStatus: "paid_approved", recordSource: "legacy_migration", page: 4, limit: 10 });
  assert.deepEqual(query.status, { $in: ["gate_in_approved", "stored_in_assigned_area"] });
  assert.equal(query.client, "id1");
  assert.equal(query.billingStatus, "paid_approved");
  assert.equal(query.recordSource, "legacy_migration");
  assert.equal(query.$or[0].bookingReference.test("X.*(2)"), true);
  assert.equal(query.$or[0].bookingReference.test("XZZ2"), false);
  assert.equal("page" in query || "limit" in query, false);
  const clientQuery = buildAdminBookingQuery({ recordSource: "client_booking" });
  assert.deepEqual(clientQuery.$and[0].$or[1], { recordSource: { $exists: false } });
});

test("inventory paginated list and export queries match for every filter", async () => {
  const User = { find: () => ({ select() { return this; }, limit() { return this; }, async lean() { return [{ _id: "clientSearch" }]; } }) };
  const YardArea = { find: () => ({ select() { return this; }, limit() { return this; }, async lean() { return [{ _id: "areaSearch" }]; } }) };
  const { query, bookingQuery, normalizedSource } = await buildInventoryQueries({
    source: "booking", areaId: "area1", status: "stored_in_assigned_area", clientId: "client1",
    loadStatus: "loaded", rateType: "international", recordSource: "legacy_migration", search: "ABC+", page: 17, limit: 10,
  }, { User, YardArea });
  assert.equal(normalizedSource, "booking");
  assert.equal(bookingQuery.assignedArea, "area1");
  assert.equal(bookingQuery.client, "client1");
  assert.equal(bookingQuery.status, "stored_in_assigned_area");
  assert.equal(bookingQuery.containerLoadStatus, "laden");
  assert.equal(bookingQuery.rateType, "international");
  assert.equal(bookingQuery.recordSource, "legacy_migration");
  assert.equal(query.status.$in.length, 0); // Booking-only status must not match legacy records.
  assert.equal(bookingQuery.$or[0].containerNumber.test("ABC+"), true);
  assert.equal(bookingQuery.$or[0].containerNumber.test("ABCCCCC"), false);
  assert.deepEqual(bookingQuery.$or.at(-2), { client: { $in: ["clientSearch"] } });
  assert.equal("page" in bookingQuery || "limit" in bookingQuery, false);
});

test("tracking exports all 1,257 matching rows although pageSize is 10", async () => {
  const original = Booking.find;
  const captured = [];
  Booking.find = fakeFind(Array.from({ length: 1257 }, (_, i) => fakeBooking(i)), captured);
  try {
    const res = createResponse();
    await exportTrackingCsv({ query: { status: "gate_in_approved", page: "3", limit: "10", search: "ABC" } }, res);
    assert.equal(res.writableEnded, true);
    assert.equal(res.body.split("\r\n").filter(Boolean).length, 1258);
    assert.match(res.body, /BK-1256/);
    assert.equal(captured[0].status, "gate_in_approved");
    assert.equal(captured[0].$or[0].bookingReference.test("ABC"), true);
    assert.equal("page" in captured[0], false);
  } finally { Booking.find = original; }
});

test("inventory exports all 1,305 filtered booking rows, never just the current page", async () => {
  const original = Booking.find;
  const captured = [];
  Booking.find = fakeFind(Array.from({ length: 1305 }, (_, i) => fakeBooking(i)), captured);
  try {
    const res = createResponse();
    await exportInventoryCsv({ query: { source: "booking", status: "gate_in_approved", page: "6", limit: "10" } }, res);
    assert.equal(res.writableEnded, true);
    assert.equal(res.body.split("\r\n").filter(Boolean).length, 1306);
    assert.match(res.body, /CON1304/);
    assert.equal(captured[0].status, "gate_in_approved");
  } finally { Booking.find = original; }
});

test("CSV exports safely quote commas, quotes, line breaks and formulas", () => {
  const unsafe = { ...fakeBooking(1), bookingReference: '=HYPERLINK("unsafe")', containerNumber: 'CON,\n"2"' };
  const { csvLine } = require("../utils/reportCsv.js");
  const output = csvLine(trackingRow(unsafe));
  assert.match(output, /"'=HYPERLINK\(""unsafe""\)"/);
  assert.match(output, /"CON,\n""2"""/);
  assert.equal(inventoryBookingRow(unsafe)[0], 'CON,\n"2"');
});

test("Container Tracking totals use all filtered records, not the displayed page", async () => {
  const files = {
    "../controllers/bookingController.js": {
      listAdminBookings: async (req, res) => res.json({
        bookings: Array.from({ length: 10 }, (_, i) => fakeBooking(i)),
        pagination: { page: 7, limit: 10, total: 1500, totalPages: 150 },
      }),
    },
    "../controllers/inventoryController.js": {},
    "../controllers/yardController.js": {},
    "../utils/storageOccupancy.js": { loadStorageOccupancy: () => Promise.resolve({}) },
  };
  const overwritten = [];
  for (const [file, value] of Object.entries(files)) {
    const key = require.resolve(file);
    overwritten.push([key, require.cache[key]]);
    require.cache[key] = { id: key, filename: key, loaded: true, exports: value };
  }
  const originalAggregate = Booking.aggregate;
  let observedMatch;
  Booking.aggregate = async (pipeline) => {
    observedMatch = pipeline[0].$match;
    return [{ total: 1500, completed: 300, active: 1100 }];
  };
  const moduleFile = require.resolve("../controllers/moduleDataController.js");
  try {
    delete require.cache[moduleFile];
    const { getBookingModuleData } = require(moduleFile);
    let body;
    const res = { json(value) { body = value; return value; } };
    await getBookingModuleData({ query: { includeSummary: "false", includeFilteredSummary: "true", status: "gate_in_approved", page: "7", limit: "10" } }, res);
    assert.equal(body.bookings.length, 10);
    assert.equal(body.pagination.total, 1500);
    assert.deepEqual(body.filteredSummary, { total: 1500, completed: 300, active: 1100 });
    assert.equal(observedMatch.status, "gate_in_approved");
    assert.equal("page" in observedMatch, false);
  } finally {
    Booking.aggregate = originalAggregate;
    delete require.cache[moduleFile];
    for (const [key, saved] of overwritten) {
      if (saved) require.cache[key] = saved;
      else delete require.cache[key];
    }
  }
});
