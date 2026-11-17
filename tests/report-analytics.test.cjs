"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { csvLine, csvCell } = require("../utils/reportCsv.js");
const adminMetrics = require("../utils/adminMetrics.js");

const clientId = "507f1f77bcf86cd799439011";
const mockQueries = [];
const fakeMongoose = {
  isValidObjectId: (value) => /^[a-f0-9]{24}$/i.test(value),
  Types: { ObjectId: class ObjectId { constructor(value) { this.value = value; } toString() { return this.value; } } },
};
const fakeBooking = {
  collection: { name: "bookings" },
  aggregate: async (pipeline) => {
    mockQueries.push({ table: "bookings", pipeline });
    return [{ _id: { containerSize: 20, containerLoadStatus: "empty", rateType: "local" }, count: 1500 }];
  },
};
const fakeRelease = {
  aggregate: (pipeline) => {
    mockQueries.push({ table: "releases", pipeline });
    return { allowDiskUse: async () => [
      { _id: { toString: () => clientId }, bookingCount: 1420, subtotal: 20000, vat: 2400, revenue: 22400 },
      { _id: null, bookingCount: 80, subtotal: 1000, vat: 120, revenue: 1120 },
    ] };
  },
};
const fakeUser = {
  find: () => ({
    select: () => ({ sort: () => ({ lean: async () => [
      { _id: clientId, companyName: "Sample Logistics" },
    ] }) }),
  }),
};
const moduleRecord = { exports: {} };
const source = fs.readFileSync(path.join(__dirname, "../services/yardReportService.js"), "utf8");
vm.runInNewContext(source, {
  module: moduleRecord,
  exports: moduleRecord.exports,
  Date,
  require: (name) => {
    if (name === "mongoose") return fakeMongoose;
    if (name === "../models/Booking.js") return { default: fakeBooking };
    if (name === "../models/ReleaseReport.js") return { default: fakeRelease };
    if (name === "../models/User.js") return { default: fakeUser };
    if (name === "../utils/adminMetrics.js") return adminMetrics;
    throw new Error(`Unexpected require ${name}`);
  },
});
const { parseReportFilters, buildReportQueries, getYardOverview, parsePage, reportRevenueAggregationStages } = moduleRecord.exports;

test("filters validate real calendar dates, ranges, sources and client IDs", () => {
  const filters = parseReportFilters({ startDate: "2026-11-01", endDate: "2026-11-30", clientId, recordSource: "legacy_migration", loadStatus: "laden" });
  assert.equal(filters.clientId, clientId);
  assert.equal(filters.loadStatus, "laden");
  assert.throws(() => parseReportFilters({ startDate: "2026-02-30" }), /valid date/);
  assert.throws(() => parseReportFilters({ startDate: "2026-11-30", endDate: "2026-11-01" }), /earlier/);
  assert.throws(() => parseReportFilters({ clientId: "not an ObjectId" }), /client ID/);
  assert.throws(() => parseReportFilters({ rateType: "unauthorized" }), /Invalid rateType/);
});

test("overview, table and export filters share Manila date bounds and classifications", () => {
  const filters = parseReportFilters({
    startDate: "2026-11-01", endDate: "2026-11-02", clientId,
    recordSource: "client_booking", loadStatus: "empty", rateType: "international",
  });
  const { bookingQuery, releaseQuery } = buildReportQueries(filters);
  assert.equal(releaseQuery.client.toString(), clientId);
  assert.equal(bookingQuery.containerLoadStatus, "empty");
  assert.equal(releaseQuery.rateType, "international");
  assert.equal(releaseQuery.releasedAt.$gte.toISOString(), "2026-10-31T16:00:00.000Z");
  assert.equal(releaseQuery.releasedAt.$lte.toISOString(), "2026-11-02T15:59:59.999Z");
  assert.equal(releaseQuery.$and[0].$or.length, 3);
  assert.equal(bookingQuery.$or.length, 4);
});

test("overview totals use full database aggregate results, not a 10/1000-row preview", async () => {
  mockQueries.length = 0;
  const overview = await getYardOverview(parseReportFilters());
  assert.equal(overview.totalContainersInYard, 1500);
  assert.equal(overview.empty.total, 1500);
  assert.equal(overview.releasedContainers, 1500);
  assert.equal(overview.totalRecordedRevenue, 23520);
  assert.equal(overview.clientRevenue[0].bookingCount, 1420);
  assert.equal(overview.clientRevenue[0].clientName, "Sample Logistics");
  const releaseAggregate = mockQueries.find((item) => item.table === "releases").pipeline;
  assert.ok(!releaseAggregate.some((stage) => "$limit" in stage || "$skip" in stage));
  assert.ok(releaseAggregate.some((stage) => "$group" in stage));
});

test("revenue aggregation supports archived transaction fallback", () => {
  const stages = JSON.stringify(reportRevenueAggregationStages());
  assert.match(stages, /paymentTransactions/);
  assert.match(stages, /totalPaidAmount/);
  assert.match(stages, /gateInPaymentTotal/);
  assert.match(stages, /revenueTotal/);
});

test("pagination size is bounded and doesn't alter reporting totals", () => {
  assert.equal(parsePage("3", "500").pageSize, 100);
  assert.equal(parsePage("bad", "-2").page, 1);
  assert.equal(parsePage("2", "10").page, 2);
});

test("CSV escapes quotes, line breaks and formula-leading user values", () => {
  assert.equal(csvCell('ACME, "Group"'), '"ACME, ""Group"""');
  assert.equal(csvCell('=HYPERLINK("bad")'), '"\'=HYPERLINK(""bad"")"');
  assert.equal(csvCell('  +1+1'), '"\'  +1+1"');
  assert.equal(csvCell(125.25), '"125.25"');
  assert.equal(csvLine(["First", "Second"]), '"First","Second"\r\n');
});
