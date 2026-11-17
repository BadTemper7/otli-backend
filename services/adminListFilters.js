"use strict";

// Keep the paginated tables, their counts, and the CSV downloads on the same
// database predicates. Neither export function accepts a page or row limit.
const INVENTORY_BOOKING_STATUSES = [
  "gate_in_approved", "stored_in_assigned_area", "gate_out_requested",
  "gate_out_approved", "gate_out_reversal_requested",
];
const INVENTORY_STORAGE_BOOKING_STATUSES = INVENTORY_BOOKING_STATUSES.filter((status) => status !== "gate_in_approved");
const INVENTORY_LEGACY_STATUSES = [
  "awaiting_yard_assignment", "in_yard", "for_billing", "pending_payment",
  "payment_verified", "cleared_for_gate_out", "released", "hold",
];
const INVENTORY_STORAGE_LEGACY_STATUSES = INVENTORY_LEGACY_STATUSES.filter((status) =>
  !["awaiting_yard_assignment", "released"].includes(status),
);
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildAdminBookingQuery = (params = {}) => {
  const { status, billingStatus, loadStatus, rateType, recordSource, clientId, search } = params;
  const query = {};
  if (clientId && clientId !== "all") query.client = clientId;
  if (status && status !== "all") {
    const statuses = String(status).split(",").map((item) => item.trim()).filter(Boolean);
    if (statuses.length) query.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }
  if (billingStatus && billingStatus !== "all") query.billingStatus = billingStatus;
  if (["empty", "laden"].includes(String(loadStatus || "").toLowerCase()))
    query.containerLoadStatus = String(loadStatus).toLowerCase();
  if (["local", "international"].includes(String(rateType || "").toLowerCase()))
    query.rateType = String(rateType).toLowerCase();
  const normalizedSource = String(recordSource || "").toLowerCase();
  if (normalizedSource === "client_booking") {
    query.$and = [
      ...(query.$and || []),
      { $or: [{ recordSource: "client_booking" }, { recordSource: { $exists: false } }, { recordSource: "" }] },
    ];
  } else if (["admin_manual", "legacy_migration"].includes(normalizedSource)) {
    query.recordSource = normalizedSource;
  }
  if (String(search || "").trim()) {
    const pattern = new RegExp(escapeRegex(String(search).trim()), "i");
    query.$or = [
      { bookingReference: pattern }, { bookingNumber: pattern },
      { legacyRegistrationNumber: pattern }, { containerNumber: pattern },
      { shippingLine: pattern },
    ];
  }
  return query;
};

const buildInventoryQueries = async (params = {}, { User, YardArea } = {}) => {
  const { areaId, blockId, status, clientId, search, loadStatus, rateType, recordSource, source = "all", view = "inventory" } = params;
  const isStorageView = String(view).toLowerCase() === "storage";
  const query = { status: { $in: isStorageView ? INVENTORY_STORAGE_LEGACY_STATUSES : INVENTORY_LEGACY_STATUSES } };
  const bookingQuery = { status: { $in: isStorageView ? INVENTORY_STORAGE_BOOKING_STATUSES : INVENTORY_BOOKING_STATUSES } };
  const normalizedSource = ["all", "booking", "legacy"].includes(String(source)) ? String(source) : "all";
  const normalizedLoadStatus = String(loadStatus || "").toLowerCase() === "loaded" ? "laden" : String(loadStatus || "").toLowerCase();
  if (clientId && clientId !== "all") { query.client = clientId; bookingQuery.client = clientId; }
  if (status && status !== "all") {
    query.status = INVENTORY_LEGACY_STATUSES.includes(status) ? status : { $in: [] };
    bookingQuery.status = INVENTORY_BOOKING_STATUSES.includes(status) ? status : { $in: [] };
  }
  if (areaId) { query.area = areaId; bookingQuery.assignedArea = areaId; }
  if (blockId) { query.block = blockId; bookingQuery.assignedBlock = blockId; }
  if (["empty", "laden"].includes(normalizedLoadStatus)) {
    query.containerStatus = normalizedLoadStatus;
    bookingQuery.containerLoadStatus = normalizedLoadStatus;
  }
  if (["local", "international"].includes(String(rateType || "").toLowerCase())) {
    query.rateType = String(rateType).toLowerCase();
    bookingQuery.rateType = String(rateType).toLowerCase();
  }
  if (recordSource && recordSource !== "all") bookingQuery.recordSource = recordSource;
  if (String(search || "").trim()) {
    const pattern = new RegExp(escapeRegex(String(search).trim()), "i");
    const [matchingClients, matchingAreas] = await Promise.all([
      User.find({ userType: "client", $or: [{ name: pattern }, { companyName: pattern }, { email: pattern }] }).select("_id").limit(100).lean(),
      YardArea.find({ $or: [{ name: pattern }, { code: pattern }] }).select("_id").limit(100).lean(),
    ]);
    const clientIds = matchingClients.map((item) => item._id);
    const areaIds = matchingAreas.map((item) => item._id);
    query.$or = [
      { containerNumber: pattern }, { bookingNumber: pattern }, { blNumber: pattern },
      { slotNumber: pattern }, { shippingLine: pattern },
      ...(clientIds.length ? [{ client: { $in: clientIds } }] : []),
      ...(areaIds.length ? [{ area: { $in: areaIds } }] : []),
    ];
    bookingQuery.$or = [
      { containerNumber: pattern }, { bookingReference: pattern }, { bookingNumber: pattern },
      { blNumber: pattern }, { legacyRegistrationNumber: pattern }, { assignedSlotNumber: pattern },
      { shippingLine: pattern },
      ...(clientIds.length ? [{ client: { $in: clientIds } }] : []),
      ...(areaIds.length ? [{ assignedArea: { $in: areaIds } }] : []),
    ];
  }
  return { query, bookingQuery, normalizedSource };
};

module.exports = {
  buildAdminBookingQuery, buildInventoryQueries,
  INVENTORY_BOOKING_STATUSES, INVENTORY_LEGACY_STATUSES,
};
