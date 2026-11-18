"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { getDashboardBuckets } = require("../utils/dashboardDateRange.js");
const {
  slotUsage, actualBookingEntry, currentYardUtilization, historicalYardUtilization,
} = require("../utils/dashboardOccupancy.js");

const date = (iso) => new Date(iso);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = date("2026-11-01T00:00:00.000Z");
const range = { period: "custom", start: T0, end: new Date(T0.getTime() + DAY - 1) };
const block = (id = "B20", containerSize = 20, teuSlots = 10, occupiedSlots = 0, status = "active") =>
  ({ _id: id, containerSize, teuSlots, occupiedSlots, status });
const booking = ({ entry, exit, size = 20, assignedBlock = "B20", ...extra }) => ({
  assignedBlock, containerSize: size,
  gateInApprovedAt: entry ? new Date(entry) : null,
  releasedAt: exit ? new Date(exit) : null,
  status: exit ? "completed_gate_out_done" : "stored_in_assigned_area",
  ...extra,
});
const compute = (overrides = {}) => historicalYardUtilization({
  range, buckets: getDashboardBuckets(range).buckets,
  blocks: [block()], bookings: [], inventory: [], releaseReports: [], ...overrides,
});

test("live occupancy uses occupied/configured block slots and leaves out inactive blocks", () => {
  const live = currentYardUtilization([
    block("A", 20, 120, 30),
    block("B", 40, 80, 28, "full"),
    block("C", 20, 1000, 1000, "inactive"),
  ]);
  assert.equal(live.capacity, 200);
  assert.equal(live.occupied, 58);
  assert.equal(live.available, 142);
  assert.equal(live.rate, 29);
  // Screenshot sanity check: 2,120 configured slots, 1,192 available.
  assert.equal(currentYardUtilization([block("yard", 20, 2120, 928)]).rate, 43.77);
});

test("20-ft and 40-ft containers use correct units for 20-ft and 40-ft blocks", () => {
  assert.equal(slotUsage(20, 20), 1);
  assert.equal(slotUsage(40, 20), 2);
  assert.equal(slotUsage(20, 40), 0.5);
  assert.equal(slotUsage(40, 40), 1);
  const result = compute({
    blocks: [block("B40", 40)],
    bookings: [
      booking({ entry: T0, size: 20, assignedBlock: "B40" }),
      booking({ entry: T0, size: 40, assignedBlock: "B40" }),
    ],
  });
  assert.equal(result.averageOccupancyRate, 15); // (0.5 + 1) / 10
  assert.equal(result.series.at(-1).occupiedSlots, 1.5);
});

test("occupancy uses exact event durations, not an average of unweighted snapshots", () => {
  const middle = new Date(T0.getTime() + 12 * HOUR);
  const result = compute({ bookings: [
    booking({ entry: T0 }), // 1 slot all day
    booking({ entry: T0, exit: middle, size: 40 }), // 2 slots for 12 hours
    booking({ entry: middle }), // 1 slot for last 12 hours
  ] });
  assert.equal(result.averageOccupancyRate, 25);
  assert.equal(result.series.at(-1).occupiedSlots, 2);
  assert.equal(result.quality.recordsUsed, 3);
});

test("scheduled arrival and assigned area are NOT actual gate-in events", () => {
  const scheduled = {
    _id: "planned", assignedBlock: "B20", containerSize: 40,
    inDate: T0, storageStartDate: T0, assignedAt: T0,
    status: "approved_area_assigned",
  };
  assert.equal(actualBookingEntry(scheduled).date, null);
  const result = compute({ bookings: [scheduled, booking({ entry: T0 })] });
  assert.equal(result.averageOccupancyRate, 10);
  assert.equal(result.quality.recordsUsed, 1);
});

test("release ends occupancy immediately, including same-day release", () => {
  const result = compute({ bookings: [booking({ entry: T0, exit: new Date(T0.getTime() + 6 * HOUR) })] });
  assert.equal(result.averageOccupancyRate, 2.5);
  assert.equal(result.series.at(-1).occupiedSlots, 0);
});

test("release report fills a missing releasedAt on completed booking", () => {
  const result = compute({
    bookings: [booking({ _id: "R-1", entry: T0, releasedAt: null, status: "completed_gate_out_done" })],
    releaseReports: [{ booking: "R-1", releasedAt: new Date(T0.getTime() + 12 * HOUR) }],
  });
  assert.equal(result.averageOccupancyRate, 5);
  assert.equal(result.quality.missingReleaseDates, 0);
});

test("completed booking with unknown exit is excluded rather than counted forever", () => {
  const result = compute({
    bookings: [booking({ entry: T0, status: "completed_gate_out_done" })],
  });
  assert.equal(result.averageOccupancyRate, 0);
  assert.equal(result.quality.missingReleaseDates, 1);
  assert.equal(result.quality.reliability, "partial");
});

test("legacy containers with storage dates contribute in their configured block's units", () => {
  const result = compute({
    inventory: [{ status: "in_yard", block: "B20", containerSize: 40, storageStartDate: T0 }],
  });
  assert.equal(result.averageOccupancyRate, 20);
  const missingHistory = compute({ inventory: [
    { status: "released", block: "B20", containerSize: 40, storageStartDate: T0, updatedAt: new Date(T0.getTime() + HOUR) },
  ] });
  assert.equal(missingHistory.averageOccupancyRate, 0);
  assert.equal(missingHistory.quality.legacyReleaseHistoryUnavailable, 1);
});

test("missing assigned block cannot silently be converted into a 20-ft slot", () => {
  const result = compute({ bookings: [booking({ entry: T0, assignedBlock: null })] });
  assert.equal(result.quality.recordsUsed, 0);
  assert.equal(result.quality.missingBlockAssignments, 1);
  assert.equal(result.quality.reliability, "partial");
});

test("historical legacy migration dates are explicitly marked estimated", () => {
  const result = compute({ bookings: [booking({
    entry: null,
    recordSource: "legacy_migration",
    historicalGateInDateType: "unknown",
    migrationDate: T0,
  })] });
  assert.equal(result.averageOccupancyRate, 10);
  assert.equal(result.quality.estimatedLegacyEntries, 1);
  assert.equal(result.quality.reliability, "estimated");
});

test("missing capacity produces N/A rather than misleading 0%", () => {
  const result = compute({ blocks: [], bookings: [booking({ entry: T0 })] });
  assert.equal(result.averageOccupancyRate, null);
  assert.equal(result.quality.reliability, "no_capacity");
  assert.equal(currentYardUtilization([]).rate, null);
});

test("overcapacity is flagged and never silently clamped to 100%", () => {
  const result = compute({ bookings: Array.from({ length: 12 }, () => booking({ entry: T0 })) });
  assert.equal(result.averageOccupancyRate, 120);
  assert.ok(result.quality.overCapacityBuckets > 0);
  assert.equal(result.series.at(-1).occupancyRate, 120);
});

test("long-period average weights days, not each month equally", () => {
  const longRange = { period: "yearly", start: date("2026-01-01T00:00:00Z"), end: date("2026-03-01T00:00:00Z") };
  const result = historicalYardUtilization({
    range: longRange,
    buckets: getDashboardBuckets(longRange).buckets,
    blocks: [block()],
    bookings: Array.from({ length: 10 }, () => booking({
      entry: longRange.start, exit: date("2026-02-01T00:00:00Z"),
    })),
  });
  assert.equal(result.series.length, 3);
  // 100% for 31 Jan days, 0% for Feb 28 days, and 0% for 1ms of March.
  assert.equal(result.averageOccupancyRate, 52.54);
});

test("data volume beyond one table page still computes full occupancy", () => {
  const result = compute({
    blocks: [block("B20", 20, 3000)],
    bookings: Array.from({ length: 1205 }, () => booking({ entry: T0 })),
  });
  assert.equal(result.quality.recordsUsed, 1205);
  assert.equal(result.averageOccupancyRate, 40.17);
});
