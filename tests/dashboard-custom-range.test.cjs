"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getDashboardRange, getDashboardBuckets } = require("../utils/dashboardDateRange.js");

const NOW = new Date("2026-11-17T05:00:00.000Z"); // Nov 17, 1 PM Philippine time.
const rangeFor = (startDate, endDate) => getDashboardRange("custom", NOW, startDate, endDate);

const covers = (buckets, date) => buckets.filter(({ start, end }) => date >= start && date <= end);

test("historical custom range includes both Philippine calendar dates, through 11:59:59.999 PM", () => {
  const range = rangeFor("2026-11-01", "2026-11-07");
  assert.equal(range.start.toISOString(), "2026-10-31T16:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-11-07T15:59:59.999Z");
  const { granularity, buckets } = getDashboardBuckets(range);
  assert.equal(granularity, "day");
  assert.equal(buckets.length, 7);
  assert.equal(buckets[0].start.getTime(), range.start.getTime());
  assert.equal(buckets.at(-1).end.getTime(), range.end.getTime());
  assert.equal(covers(buckets, range.end).length, 1);
  assert.equal(covers(buckets, new Date(range.end.getTime() + 1)).length, 0);
});

test("single historical day shows all 24 hours, not hours from today's clock", () => {
  const range = rangeFor("2026-11-10", "2026-11-10");
  const { granularity, buckets } = getDashboardBuckets(range);
  assert.equal(granularity, "hour");
  assert.equal(buckets.length, 24);
  assert.equal(buckets[0].start.toISOString(), "2026-11-09T16:00:00.000Z");
  assert.equal(buckets.at(-1).end.toISOString(), "2026-11-10T15:59:59.999Z");
});

test("custom range ending today stops at now and uses Philippine time", () => {
  const range = rangeFor("2026-11-16", "2026-11-17");
  assert.equal(range.start.toISOString(), "2026-11-15T16:00:00.000Z");
  assert.equal(range.end.toISOString(), NOW.toISOString());
  const { buckets } = getDashboardBuckets(range);
  assert.equal(buckets.length, 2);
  assert.equal(buckets.at(-1).end.toISOString(), NOW.toISOString());
});

test("multi-month custom range produces chronological monthly buckets, including partial months", () => {
  const range = rangeFor("2025-12-15", "2026-11-01");
  const { granularity, buckets } = getDashboardBuckets(range);
  assert.equal(granularity, "month");
  assert.equal(buckets.length, 12);
  assert.equal(buckets[0].key, "2025-12");
  assert.equal(buckets.at(-1).key, "2026-11");
  assert.equal(buckets[0].start.toISOString(), range.start.toISOString());
  assert.equal(buckets.at(-1).end.toISOString(), range.end.toISOString());
  assert.match(buckets[0].label, /25/);
});

test("ranges spanning over five years group by year without losing selected dates", () => {
  const range = rangeFor("2018-02-14", "2026-11-17");
  const { granularity, buckets } = getDashboardBuckets(range);
  assert.equal(granularity, "year");
  assert.equal(buckets.length, 9);
  assert.equal(buckets[0].start.toISOString(), range.start.toISOString());
  assert.equal(buckets.at(-1).end.toISOString(), range.end.toISOString());
});

test("invalid, missing, reversed, impossible and future date ranges are rejected", () => {
  assert.throws(() => rangeFor("", "2026-11-16"), /YYYY-MM-DD/);
  assert.throws(() => rangeFor("2026-02-30", "2026-03-01"), /valid calendar/);
  assert.throws(() => rangeFor("2026-11-15", "2026-11-13"), /later/);
  assert.throws(() => rangeFor("2026-11-18", "2026-11-18"), /future/);
  assert.throws(() => rangeFor("2026-11-17", "2026-11-18"), /future/);
  assert.throws(() => rangeFor("2026-11-16T00:00", "2026-11-17"), /YYYY-MM-DD/);
});

test("preset periods retain their original start-of-week/month/year and now boundaries", () => {
  const expected = {
    daily: "2026-11-16T16:00:00.000Z",
    weekly: "2026-11-15T16:00:00.000Z",
    monthly: "2026-10-31T16:00:00.000Z",
    yearly: "2025-12-31T16:00:00.000Z",
  };
  for (const [period, start] of Object.entries(expected)) {
    const range = getDashboardRange(period, NOW);
    assert.equal(range.start.toISOString(), start, period);
    assert.equal(range.end.toISOString(), NOW.toISOString(), period);
    assert.ok(getDashboardBuckets(range).buckets.length, period);
  }
});

test("leap day and month boundaries validate and bucket correctly", () => {
  const range = getDashboardRange("custom", NOW, "2024-02-29", "2024-03-01");
  assert.equal(getDashboardBuckets(range).buckets.length, 2);
  assert.equal(range.end.toISOString(), "2024-03-01T15:59:59.999Z");
});

const mockDefault = (relative, value) => {
  const key = require.resolve(relative);
  require.cache[key] = { id: key, filename: key, loaded: true, exports: { __esModule: true, default: value } };
};
const mockDependency = (relative, value) => {
  const key = require.resolve(relative);
  require.cache[key] = { id: key, filename: key, loaded: true, exports: value };
};
const queryChain = (rows) => ({
  select() { return this; }, populate() { return this; }, sort() { return this; }, limit() { return this; },
  lean: async () => rows,
});

const records = {
  bookings: [
    { containerSize: 20, gateInApprovedAt: new Date("2026-10-31T16:00:00.000Z") },
    { containerSize: 40, gateInApprovedAt: new Date("2026-11-01T11:00:00.000Z") },
    { containerSize: 20, gateInApprovedAt: new Date("2026-11-07T15:59:59.999Z") },
  ],
  releases: [
    { releasedAt: new Date("2026-10-31T16:00:00.000Z"), totalPaidAmount: 100, client: { _id: "client-1", companyName: "A" } },
    { releasedAt: new Date("2026-11-07T15:59:59.999Z"), totalPaidAmount: 250, client: { _id: "client-1", companyName: "A" } },
  ],
  legacy: [],
  blocks: [{ _id: "block-1", status: "active", containerSize: 20, teuSlots: 100, occupiedSlots: 3 }],
};
let capturedReleaseQuery;
mockDefault("../models/Booking.js", {
  find: (filter) => queryChain(filter?.status?.$in ? records.bookings.filter((row) => filter.status.$in.includes(row.status)) : records.bookings),
  countDocuments: async () => 0,
});
mockDefault("../models/ReleaseReport.js", {
  find: (filter) => { capturedReleaseQuery = filter; return queryChain(records.releases); },
});
mockDefault("../models/YardBlock.js", {
  find: () => queryChain(records.blocks),
});
mockDefault("../models/InventoryContainer.js", {
  find: (filter) => queryChain(filter?.status ? records.legacy.filter((row) => row.status !== "released") : records.legacy),
});
mockDefault("../models/User.js", {
  find: () => queryChain([]), countDocuments: async () => 0,
});
mockDependency("../services/yardReportService.js", {
  parseReportFilters: () => ({}), buildReportQueries: () => ({}), getYardOverview: async () => ({}), parsePage: () => ({}),
});
const { getOperationsDashboard } = require("../controllers/reportController.js");

const fakeRes = () => ({
  code: 200,
  status(value) { this.code = value; return this; },
  json(value) { this.data = value; return value; },
});

test("dashboard API uses full filtered date interval for metrics, chart series and customer revenue", async () => {
  const res = fakeRes();
  await getOperationsDashboard({ query: { period: "custom", startDate: "2026-11-01", endDate: "2026-11-07" } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.data.period, "custom");
  assert.equal(res.data.metrics.containersReceived, 3);
  assert.equal(res.data.metrics.containersReleased, 2);
  assert.equal(res.data.metrics.revenue, 350);
  assert.equal(res.data.metrics.topCustomer.name, "A");
  assert.equal(res.data.metrics.topCustomer.transactionCount, 2);
  assert.equal(res.data.trend.series.length, 7);
  assert.equal(capturedReleaseQuery.releasedAt.$gte.toISOString(), "2026-10-31T16:00:00.000Z");
  assert.equal(capturedReleaseQuery.releasedAt.$lte.toISOString(), "2026-11-07T15:59:59.999Z");
});

test("dashboard API returns HTTP 400 without querying database for invalid custom dates", async () => {
  capturedReleaseQuery = undefined;
  const res = fakeRes();
  await getOperationsDashboard({ query: { period: "custom", startDate: "2026-11-12", endDate: "2026-11-01" } }, res);
  assert.equal(res.code, 400);
  assert.match(res.data.message, /later/);
  assert.equal(capturedReleaseQuery, undefined);
});


test("dashboard API returns occupancy math from backend, not from table pages or scheduled bookings", async () => {
  const saved = { bookings: records.bookings, releases: records.releases, legacy: records.legacy, blocks: records.blocks };
  try {
    const start = new Date("2026-10-31T16:00:00.000Z"); // Nov 1 at 00:00 Manila
    const half = new Date("2026-11-01T04:00:00.000Z");
    records.blocks = [{ _id: "block-1", teuSlots: 10, occupiedSlots: 3, containerSize: 20, status: "active" }];
    records.bookings = [
      { _id: "A", assignedBlock: "block-1", containerSize: 20, gateInApprovedAt: start, status: "stored_in_assigned_area" },
      { _id: "B", assignedBlock: "block-1", containerSize: 40, gateInApprovedAt: start, releasedAt: half, status: "completed_gate_out_done" },
      { _id: "scheduled", assignedBlock: "block-1", containerSize: 40, inDate: start, storageStartDate: start, status: "pending_admin_approval" },
    ];
    records.legacy = [{ status: "in_yard", block: "block-1", containerSize: 20, storageStartDate: start, rateType: "local" }];
    records.releases = [];
    const res = fakeRes();
    await getOperationsDashboard({ query: { period: "custom", startDate: "2026-11-01", endDate: "2026-11-01" } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.data.metrics.averageOccupancyRate, 30); // (1 + 1 + 2*0.5)/10
    assert.equal(res.data.trend.occupancyAverageRate, 30);
    assert.equal(res.data.metrics.currentOccupancyRate, 30); // 3 stored / 10 configured
    assert.equal(res.data.metrics.availableYardCapacity, 7);
    assert.equal(res.data.metrics.currentInventory, 2); // Active A and legacy in_yard only
    assert.equal(res.data.metrics.localContainers, 2);
    assert.equal(res.data.trend.series.at(-1).occupancyRate, 20); // B released at noon
    assert.equal(res.data.metrics.occupancyQuality.recordsUsed, 3);
    assert.equal(res.data.metrics.occupancyQuality.reliability, "verified_from_records");
  } finally {
    Object.assign(records, saved);
  }
});
