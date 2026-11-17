"use strict";

const Booking = require("../models/Booking.js").default;
const InventoryContainer = require("../models/InventoryContainer.js").default;
const User = require("../models/User.js").default;
const YardArea = require("../models/YardArea.js").default;
const { buildAdminBookingQuery, buildInventoryQueries } = require("../services/adminListFilters.js");
const { csvLine } = require("../utils/reportCsv.js");

const PH_DATE = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const dateTime = (value) => {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : PH_DATE.format(date);
};
const displayName = (record) => record?.companyName || record?.name || record?.email || "";
const prettify = (value) => String(value || "").replace(/_/g, " ");
const location = (doc, field) => doc?.[field]?.name || doc?.[field]?.code || "";
const bookingDateIn = (doc) => doc.inDate || doc.expectedArrivalDate;
const startDownload = (res, prefix) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${prefix}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.write("\uFEFF"); // UTF-8 BOM so Excel reads non-ASCII client names correctly.
};
const sendCsv = async (res, values) => {
  if (res.destroyed || res.writableEnded) return false;
  if (!res.write(csvLine(values))) {
    await new Promise((resolve) => {
      const finish = () => { res.off("drain", finish); res.off("close", finish); resolve(); };
      res.once("drain", finish);
      res.once("close", finish);
    });
  }
  return !res.destroyed && !res.writableEnded;
};
const streamRows = async (res, cursor, toRow) => {
  try {
    for await (const doc of cursor) {
      if (!await sendCsv(res, toRow(doc))) break;
    }
  } finally {
    if (typeof cursor.close === "function") await cursor.close();
  }
};

const trackingHeaders = [
  "Booking Reference", "Client", "Client Email", "Container Number", "Size (ft)", "Container Type",
  "Load Status", "Rate Classification", "Record Source", "Booking Status", "Billing Status",
  "Billing Total (PHP)", "Shipping Line", "Booking Number", "Yard Area", "Yard Block",
  "Yard Slot", "Gate-In / Arrival (PH)", "Gate-Out (PH)", "Last Updated (PH)", "Created (PH)",
];
const trackingRow = (doc) => [
  doc.bookingReference, displayName(doc.client), doc.client?.email,
  doc.containerNumber, doc.containerSize, doc.containerType,
  doc.containerLoadStatus, doc.rateType, doc.recordSource || "client_booking",
  prettify(doc.status), prettify(doc.billingStatus), Number(doc.billingTotal || doc.paymentAmount) || 0,
  doc.shippingLine, doc.bookingNumber, location(doc, "assignedArea"), location(doc, "assignedBlock"),
  doc.assignedSlotNumber, dateTime(bookingDateIn(doc)), dateTime(doc.outDate),
  dateTime(doc.updatedAt), dateTime(doc.createdAt),
];
const inventoryHeaders = [
  "Container Number", "Booking Reference", "Client", "Source", "Size (ft)", "Container Type",
  "Load Status", "Rate Classification", "Inventory Status", "Billing Status", "Yard Area",
  "Yard Block", "Yard Slot", "Bay", "Row", "Tier", "Shipping Line",
  "Gate-In Accepted (PH)", "Stored At (PH)", "Gate-Out (PH)", "Last Updated (PH)",
];
const inventoryBookingRow = (doc) => [
  doc.containerNumber, doc.bookingReference, displayName(doc.client), doc.recordSource || "client_booking",
  doc.containerSize, doc.containerType, doc.containerLoadStatus, doc.rateType,
  prettify(doc.status), prettify(doc.billingStatus), location(doc, "assignedArea"),
  location(doc, "assignedBlock"), doc.assignedSlotNumber, doc.assignedBay, doc.assignedRow, doc.assignedTier,
  doc.shippingLine, dateTime(doc.gateInApprovedAt || doc.storedAt || doc.storageStartDate || doc.updatedAt || doc.createdAt),
  dateTime(doc.storedAt), dateTime(doc.outDate), dateTime(doc.updatedAt),
];
const inventoryLegacyRow = (doc) => [
  doc.containerNumber, doc.bookingNumber, displayName(doc.client) || doc.customerName, "legacy_inventory",
  doc.containerSize, doc.containerType, doc.containerStatus, doc.rateType,
  prettify(doc.status), "", location(doc, "area"), location(doc, "block"),
  doc.slotNumber, doc.bay, doc.row, doc.tier, doc.shippingLine,
  dateTime(doc.storageStartDate || doc.createdAt), dateTime(doc.storageStartDate), "", dateTime(doc.updatedAt),
];

const exportTrackingCsv = async (req, res) => {
  const query = buildAdminBookingQuery(req.query);
  const cursor = Booking.find(query)
    .select("bookingReference client containerNumber containerSize containerType containerLoadStatus rateType recordSource status billingStatus billingTotal paymentAmount shippingLine bookingNumber assignedArea assignedBlock assignedSlotNumber inDate expectedArrivalDate outDate updatedAt createdAt")
    .populate("client", "name companyName email")
    .populate("assignedArea", "name code")
    .populate("assignedBlock", "name code")
    .sort({ createdAt: -1, _id: -1 }).lean().cursor({ batchSize: 100 });
  startDownload(res, "container-tracking-filtered");
  try {
    await sendCsv(res, trackingHeaders);
    await streamRows(res, cursor, trackingRow);
    if (!res.destroyed) res.end();
  } catch (error) {
    if (typeof cursor.close === "function") await cursor.close();
    if (!res.headersSent) throw error;
    res.destroy(error);
  }
};

const exportInventoryCsv = async (req, res) => {
  const { query, bookingQuery, normalizedSource } = await buildInventoryQueries(req.query, { User, YardArea });
  // The Inventory screen requests source=booking. Legacy/all are also supported
  // for API consumers, with the same predicates as the paginated inventory list.
  const bookingCursor = normalizedSource !== "legacy" ? Booking.find(bookingQuery)
    .select("bookingReference client recordSource containerNumber containerSize containerType containerLoadStatus rateType status billingStatus assignedArea assignedBlock assignedSlotNumber assignedBay assignedRow assignedTier shippingLine gateInApprovedAt storedAt storageStartDate outDate updatedAt createdAt")
    .populate("client", "name companyName email")
    .populate("assignedArea", "name code")
    .populate("assignedBlock", "name code")
    .sort({ gateInApprovedAt: -1, updatedAt: -1, _id: -1 }).lean().cursor({ batchSize: 100 }) : null;
  const legacyCursor = normalizedSource !== "booking" ? InventoryContainer.find(query)
    .select("bookingNumber customerName client containerNumber containerSize containerType containerStatus rateType status area block slotNumber bay row tier shippingLine storageStartDate updatedAt createdAt")
    .populate("client", "name companyName email")
    .populate("area", "name code")
    .populate("block", "name code")
    .sort({ createdAt: -1, _id: -1 }).lean().cursor({ batchSize: 100 }) : null;
  startDownload(res, "inventory-filtered");
  try {
    await sendCsv(res, inventoryHeaders);
    if (bookingCursor) await streamRows(res, bookingCursor, inventoryBookingRow);
    if (legacyCursor && !res.destroyed) await streamRows(res, legacyCursor, inventoryLegacyRow);
    if (!res.destroyed) res.end();
  } catch (error) {
    if (bookingCursor && typeof bookingCursor.close === "function") await bookingCursor.close();
    if (legacyCursor && typeof legacyCursor.close === "function") await legacyCursor.close();
    if (!res.headersSent) throw error;
    res.destroy(error);
  }
};

module.exports = {
  exportTrackingCsv, exportInventoryCsv, trackingHeaders, trackingRow,
  inventoryHeaders, inventoryBookingRow, inventoryLegacyRow, streamRows,
};
