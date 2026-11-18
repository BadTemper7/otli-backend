"use strict";

// Dashboard occupancy is expressed in the configured block's slot unit.
// A 20-foot container takes half a 40-foot slot; a 40-foot container takes
// two 20-foot slots. Counting every 40-footer as two slots in every block
// artificially inflates utilization in mixed-size yards.
const slotUsage = (containerSize, blockSize = 20) => {
  const isForty = Number(containerSize) === 40;
  return Number(blockSize) === 40 ? (isForty ? 1 : 0.5) : (isForty ? 2 : 1);
};

const dateOrNull = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};
const idOf = (record) => {
  const value = record?._id ?? record?.id ?? record;
  return value && typeof value.toString === "function" ? value.toString() : "";
};
const roundRate = (value) => Math.round(value * 100) / 100;

// Scheduled inDate, expectedArrivalDate, assignedAt, approvedAt and generic
// storageStartDate on a normal booking do NOT prove physical Gate-In. In the
// actual booking workflow storageStartDate can be assigned before Gate-In.
const actualBookingEntry = (booking, releasedReport) => {
  const confirmed = dateOrNull(booking.gateInApprovedAt) || dateOrNull(booking.storedAt)
    || dateOrNull(releasedReport?.gateInAt);
  if (confirmed) return { date: confirmed, estimated: false };
  if (booking.recordSource === "legacy_migration") {
    const historical = booking.historicalGateInDateType === "exact"
      ? dateOrNull(booking.inDate) : null;
    const estimated = historical || dateOrNull(booking.migrationDate)
      || dateOrNull(booking.legacyRegisteredAt) || dateOrNull(booking.createdAt);
    if (estimated) return { date: estimated, estimated: !historical };
  }
  return { date: null, estimated: false };
};

const bookingIsTerminalWithoutExit = (booking, exit) => !exit &&
  ["completed_gate_out_done", "cancelled", "rejected"].includes(booking.status);

// Use stored block counters for CURRENT allocated yard-space utilization.
// This matches the operational available-slot ledger and includes reservations.
const currentYardUtilization = (blocks) => {
  const valid = blocks.filter((block) => ["active", "full"].includes(block.status || "active"));
  const capacity = valid.reduce((sum, block) => sum + Math.max(0, Number(block.teuSlots) || 0), 0);
  const occupied = valid.reduce((sum, block) => sum + Math.max(0, Number(block.occupiedSlots) || 0), 0);
  return {
    capacity,
    occupied,
    available: Math.max(capacity - occupied, 0),
    rate: capacity > 0 ? roundRate(occupied / capacity * 100) : null,
  };
};

// Historical utilization is a time-weighted average of documented physical
// Gate-In -> release intervals, not an average of bucket-end snapshots.
// No historical YardBlock-capacity snapshots exist in the current schema:
// the denominator is explicitly today's configured capacity and quality
// metadata warns about records that cannot be reconstructed accurately.
const historicalYardUtilization = ({ range, buckets, bookings = [], inventory = [], releaseReports = [], blocks = [] }) => {
  const live = currentYardUtilization(blocks);
  const blockById = new Map(blocks.filter((b) => ["active", "full"].includes(b.status || "active"))
    .map((b) => [idOf(b), b]));
  const reportByBookingId = new Map(releaseReports.filter((r) => r.booking)
    .map((r) => [idOf(r.booking), r]));
  const quality = {
    capacityBasis: "current_configured_blocks",
    historicalMethod: "time_weighted_confirmed_gate_in",
    recordsUsed: 0,
    estimatedLegacyEntries: 0,
    missingGateInDates: 0,
    missingBlockAssignments: 0,
    missingReleaseDates: 0,
    legacyReleaseHistoryUnavailable: 0,
    overCapacityBuckets: 0,
  };
  const intervals = [];
  const rangeEnd = range.end.getTime() + 1;
  const addInterval = ({ entry, exit, containerSize, blockRef, estimated = false }) => {
    if (!entry || entry.getTime() >= rangeEnd || (exit && exit <= range.start)) return;
    const block = blockById.get(idOf(blockRef));
    if (!block) { quality.missingBlockAssignments += 1; return; }
    const from = entry.getTime();
    const until = exit ? exit.getTime() : Infinity;
    if (until <= from) return;
    intervals.push({ from, until, slots: slotUsage(containerSize, block.containerSize) });
    quality.recordsUsed += 1;
    if (estimated) quality.estimatedLegacyEntries += 1;
  };
  for (const booking of bookings) {
    const report = reportByBookingId.get(idOf(booking));
    const { date: entry, estimated } = actualBookingEntry(booking, report);
    if (!entry) {
      // A future or unapproved booking must NOT be counted as occupying yard.
      // Only flag an untraceable physical record or completed release.
      if (["gate_in_approved", "stored_in_assigned_area", "gate_out_requested", "gate_out_approved", "gate_out_reversal_requested", "completed_gate_out_done"].includes(booking.status)) {
        quality.missingGateInDates += 1;
      }
      continue;
    }
    const exit = dateOrNull(booking.releasedAt) || dateOrNull(report?.releasedAt);
    if (bookingIsTerminalWithoutExit(booking, exit)) {
      quality.missingReleaseDates += 1;
      continue; // Never treat a finished booking as indefinitely in the yard.
    }
    addInterval({ entry, exit, containerSize: booking.containerSize, blockRef: booking.assignedBlock, estimated });
  }
  for (const container of inventory) {
    if (container.status === "released") {
      // This legacy model contains no release date. updatedAt is NOT a safe
      // substitute because subsequent edits can change it.
      quality.legacyReleaseHistoryUnavailable += 1;
      continue;
    }
    const entry = dateOrNull(container.storageStartDate) || dateOrNull(container.createdAt);
    if (!entry) { quality.missingGateInDates += 1; continue; }
    addInterval({ entry, containerSize: container.containerSize, blockRef: container.block });
  }

  const start = range.start.getTime();
  const endExclusive = range.end.getTime() + 1;
  let totalOccupiedSlotMs = 0;
  const series = buckets.map((bucket) => {
    const left = bucket.start.getTime();
    const right = bucket.end.getTime() + 1;
    const duration = Math.max(1, right - left);
    let slotMilliseconds = 0;
    let endSlots = 0;
    for (const interval of intervals) {
      const overlap = Math.min(interval.until, right) - Math.max(interval.from, left);
      if (overlap > 0) slotMilliseconds += interval.slots * overlap;
      if (interval.from < right && interval.until >= right) endSlots += interval.slots;
    }
    totalOccupiedSlotMs += slotMilliseconds;
    const occupancyRate = live.capacity > 0 ? roundRate(slotMilliseconds / duration / live.capacity * 100) : null;
    if (occupancyRate !== null && occupancyRate > 100) quality.overCapacityBuckets++;
    return { key: bucket.key, occupiedSlots: roundRate(endSlots), occupancyRate };
  });
  const rangeDuration = Math.max(1, endExclusive - start);
  const averageOccupancyRate = live.capacity > 0
    ? roundRate(totalOccupiedSlotMs / rangeDuration / live.capacity * 100)
    : null;
  const incomplete = quality.missingGateInDates + quality.missingBlockAssignments
    + quality.missingReleaseDates + quality.legacyReleaseHistoryUnavailable > 0;
  quality.reliability = live.capacity <= 0 ? "no_capacity" : incomplete ? "partial" :
    quality.estimatedLegacyEntries > 0 ? "estimated" : "verified_from_records";
  return { averageOccupancyRate, series, quality };
};

module.exports = { slotUsage, actualBookingEntry, currentYardUtilization, historicalYardUtilization };
