"use strict";

const BOOKING_SUMMARY_FIELDS = {
  pending: ["status", "pending_admin_approval"],
  approved: ["status", "approved_area_assigned"],
  gateIn: ["status", "gate_in_approved"],
  stored: ["status", "stored_in_assigned_area"],
  gateOutRequested: ["status", "gate_out_requested"],
  gateOutReversalRequested: ["status", "gate_out_reversal_requested"],
  completed: ["status", "completed_gate_out_done"],
  unpaid: ["billingStatus", "unpaid"],
  paymentReview: ["billingStatus", "payment_under_review"],
  paid: ["billingStatus", "paid_approved"],
};

const BOOKING_SUMMARY_KEYS = ["total", ...Object.keys(BOOKING_SUMMARY_FIELDS)];
const bookingSummaryPipeline = () => [{
  $group: {
    _id: null,
    total: { $sum: 1 },
    ...Object.fromEntries(Object.entries(BOOKING_SUMMARY_FIELDS).map(([key, [field, value]]) => [key, {
      $sum: { $cond: [{ $eq: [`$${field}`, value] }, 1, 0] },
    }])),
  },
}];
const normalizeBookingSummary = (row = {}) => Object.fromEntries(
  BOOKING_SUMMARY_KEYS.map((key) => [key, Number(row?.[key]) || 0]),
);

const yardBookingPipeline = (query) => [
  { $match: query },
  { $group: {
    _id: { containerSize: "$containerSize", containerLoadStatus: "$containerLoadStatus", rateType: "$rateType", recordSource: "$recordSource" },
    count: { $sum: 1 },
  } },
];
const emptyCounts = () => ({ 20: 0, 40: 0, total: 0 });
const summarizeYardBookingGroups = (groups = []) => {
  const empty = emptyCounts();
  const laden = emptyCounts();
  const local = emptyCounts();
  const international = emptyCounts();
  let totalContainersInYard = 0;
  let totalTeu = 0;
  let totalFeu = 0;
  let legacyContainers = 0;
  const add = (bucket, size, count) => { bucket[size] += count; bucket.total += count; };
  for (const group of groups) {
    const size = Number(group._id?.containerSize) === 40 ? 40 : 20;
    const count = Number(group.count) || 0;
    const load = String(group._id?.containerLoadStatus || "laden").toLowerCase();
    const rate = String(group._id?.rateType || "local").toLowerCase();
    add(load === "empty" ? empty : laden, size, count);
    add(rate === "international" ? international : local, size, count);
    if (group._id?.recordSource === "legacy_migration") legacyContainers += count;
    totalContainersInYard += count;
    totalTeu += (size === 40 ? 2 : 1) * count;
    totalFeu += (size === 40 ? 1 : 0.5) * count;
  }
  return { empty, laden, local, international, legacyContainers, totalTeu, totalFeu, totalContainersInYard };
};
module.exports = { BOOKING_SUMMARY_FIELDS, BOOKING_SUMMARY_KEYS, bookingSummaryPipeline, normalizeBookingSummary, yardBookingPipeline, summarizeYardBookingGroups };
