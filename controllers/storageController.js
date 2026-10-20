"use strict";

const Booking = require("../models/Booking.js").default;
const InventoryContainer = require("../models/InventoryContainer.js").default;
const User = require("../models/User.js").default;
const YardArea = require("../models/YardArea.js").default;
const {
    STORED_BOOKING_STATUSES,
    STORED_LEGACY_STATUSES,
} = require("../utils/storageOccupancy.js");
const { planStoragePage } = require("../utils/storagePagination.js");

const BOOKING_FIELDS = [
    "client", "recordSource", "bookingReference", "legacyRegistrationNumber",
    "containerNumber", "containerSize", "containerType", "containerLoadStatus",
    "rateType", "shippingLine", "bookingNumber", "blNumber", "status",
    "assignedArea", "assignedBlock", "assignedBay", "assignedRow", "assignedTier",
    "assignedSlotNumber", "storedAt", "storageStartDate", "gateInApprovedAt",
    "outDate", "releasedAt", "gateOutGracePeriodMinutes", "updatedAt", "createdAt",
].join(" ");
const LEGACY_FIELDS = [
    "client", "containerNumber", "containerSize", "containerType", "containerStatus",
    "rateType", "shippingLine", "bookingNumber", "blNumber", "customerName",
    "status", "area", "block", "bay", "row", "tier", "slotNumber",
    "storageStartDate", "updatedAt", "createdAt",
].join(" ");
const VIS_BOOKING_FIELDS = "assignedArea assignedBlock assignedBay assignedRow assignedTier containerNumber containerSize containerLoadStatus rateType client storageStartDate storedAt updatedAt";
const VIS_LEGACY_FIELDS = "area block bay row tier containerNumber containerSize containerStatus rateType client customerName storageStartDate updatedAt";
const bool = (value) => String(value || "").toLowerCase() === "true";
const strId = (value) => value == null ? "" : String(value._id || value);
const normRate = (value) => String(value || "").toLowerCase() === "international" ? "international" : "local";

const safeBooking = (row) => {
    const client = row.client || {};
    const scheduledAt = row.outDate ? new Date(row.outDate) : null;
    const grace = Math.max(Number(row.gateOutGracePeriodMinutes ?? process.env.GATE_OUT_GRACE_PERIOD_MINUTES ?? 120) || 0, 0);
    const overstayStart = scheduledAt && !Number.isNaN(scheduledAt.getTime())
        ? new Date(scheduledAt.getTime() + grace * 60000) : null;
    const pendingGateOut = ["gate_out_approved", "gate_out_reversal_requested"].includes(row.status) && !row.releasedAt;
    const isOverstaying = Boolean(pendingGateOut && overstayStart && Date.now() > overstayStart.getTime());
    return {
        id: strId(row._id), source: "booking", recordSource: row.recordSource || "client_booking",
        bookingReference: row.bookingReference || row.legacyRegistrationNumber || "",
        clientName: client.companyName || client.name || "",
        containerNumber: row.containerNumber, containerSize: row.containerSize,
        containerType: row.containerType, containerLoadStatus: row.containerLoadStatus,
        containerStatus: row.containerLoadStatus, rateType: normRate(row.rateType),
        shippingLine: row.shippingLine || "", bookingNumber: row.bookingNumber || "",
        blNumber: row.blNumber || "", bookingStatus: row.status, status: row.status,
        area: strId(row.assignedArea), areaName: row.assignedArea?.name || "",
        block: strId(row.assignedBlock), blockName: row.assignedBlock?.name || "",
        blockCode: row.assignedBlock?.code || "", slotNumber: row.assignedSlotNumber || "",
        bay: row.assignedBay || 1, row: row.assignedRow || 1, tier: row.assignedTier || 1,
        storageStartDate: row.storageStartDate, storedAt: row.storedAt,
        outDate: row.outDate, updatedAt: row.updatedAt, createdAt: row.createdAt,
        gateOutOverstayStartedAt: overstayStart,
        gateOutScheduleStatus: row.releasedAt ? "released" : isOverstaying ? "overstaying"
            : pendingGateOut ? "awaiting_release" : scheduledAt ? "scheduled" : "not_scheduled",
        isOverstaying,
    };
};
const safeLegacy = (row) => ({
    id: strId(row._id), source: "pre_advice", recordSource: "pre_advice",
    bookingReference: row.bookingNumber || "", clientName: row.client?.companyName || row.client?.name || row.customerName || "",
    containerNumber: row.containerNumber, containerSize: row.containerSize,
    containerType: row.containerType, containerLoadStatus: row.containerStatus,
    containerStatus: row.containerStatus, rateType: normRate(row.rateType),
    shippingLine: row.shippingLine || "", bookingNumber: row.bookingNumber || "",
    blNumber: row.blNumber || "", status: row.status,
    area: strId(row.area), areaName: row.area?.name || "",
    block: strId(row.block), blockName: row.block?.name || "",
    blockCode: row.block?.code || "", slotNumber: row.slotNumber || "",
    bay: row.bay || 1, row: row.row || 1, tier: row.tier || 1,
    storageStartDate: row.storageStartDate, storedAt: row.storageStartDate,
    updatedAt: row.updatedAt, createdAt: row.createdAt,
} );

const safeVisualBooking = (row) => ({
    id: strId(row._id), area: strId(row.assignedArea), block: strId(row.assignedBlock),
    bay: row.assignedBay || 1, row: row.assignedRow || 1, tier: row.assignedTier || 1,
    containerNumber: row.containerNumber, containerSize: row.containerSize,
    containerLoadStatus: row.containerLoadStatus, rateType: row.rateType,
    clientName: row.client?.companyName || row.client?.name || "",
    storageStartDate: row.storageStartDate, storedAt: row.storedAt, updatedAt: row.updatedAt,
});
const safeVisualLegacy = (row) => ({
    id: strId(row._id), area: strId(row.area), block: strId(row.block),
    bay: row.bay || 1, row: row.row || 1, tier: row.tier || 1,
    containerNumber: row.containerNumber, containerSize: row.containerSize,
    containerLoadStatus: row.containerStatus, rateType: row.rateType,
    clientName: row.client?.companyName || row.client?.name || row.customerName || "",
    storageStartDate: row.storageStartDate, storedAt: row.storageStartDate, updatedAt: row.updatedAt,
});

const loadVisualization = async ({ areaId, source, requestedLimit, full = false }) => {
    // Only the trusted selected-area route uses full=true. Legacy callers
    // remain bounded, so external flags cannot request an unlimited dump.
    const limit = full ? null : Math.min(Math.max(Math.floor(Number(requestedLimit)) || 5000, 1), 5000);
    const bookingQuery = Booking.find({ assignedArea: areaId, status: { $in: STORED_BOOKING_STATUSES } })
        .select(VIS_BOOKING_FIELDS).populate("client", "name companyName");
    const legacyQuery = InventoryContainer.find({ area: areaId, status: { $in: STORED_LEGACY_STATUSES } })
        .select(VIS_LEGACY_FIELDS).populate("client", "name companyName");
    if (limit !== null) {
        bookingQuery.limit(limit + 1);
        legacyQuery.limit(limit + 1);
    }
    const [bookings, legacy] = await Promise.all([
        source === "legacy" ? [] : bookingQuery.lean(),
        source === "booking" ? [] : legacyQuery.lean(),
    ]);
    const combined = [...bookings.map(safeVisualBooking), ...legacy.map(safeVisualLegacy)];
    return {
        visualContainers: limit === null ? combined : combined.slice(0, limit),
        visualizationTruncated: limit !== null && combined.length > limit,
    };
};

const buildFilters = async (params) => {
    const booking = { status: { $in: STORED_BOOKING_STATUSES } };
    const legacy = { status: { $in: STORED_LEGACY_STATUSES } };
    if (params.areaId) { booking.assignedArea = params.areaId; legacy.area = params.areaId; }
    if (params.blockId) { booking.assignedBlock = params.blockId; legacy.block = params.blockId; }
    if (params.clientId && params.clientId !== "all") { booking.client = params.clientId; legacy.client = params.clientId; }
    if (params.status && params.status !== "all") {
        booking.status = STORED_BOOKING_STATUSES.includes(params.status) ? params.status : { $in: [] };
        legacy.status = STORED_LEGACY_STATUSES.includes(params.status) ? params.status : { $in: [] };
    }
    const loadStatus = String(params.loadStatus || "").toLowerCase().replace(/^loaded$/, "laden");
    if (["empty", "laden"].includes(loadStatus)) { booking.containerLoadStatus = loadStatus; legacy.containerStatus = loadStatus; }
    const rateType = String(params.rateType || "").toLowerCase();
    if (["local", "international"].includes(rateType)) { booking.rateType = rateType; legacy.rateType = rateType; }
    if (params.recordSource && params.recordSource !== "all") booking.recordSource = params.recordSource;

    const search = String(params.search || "").trim().slice(0, 100);
    if (search) {
        const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const [clients, areas] = await Promise.all([
            User.find({ userType: "client", $or: [{ name: pattern }, { companyName: pattern }, { email: pattern }] }).select("_id").limit(100).lean(),
            YardArea.find({ $or: [{ name: pattern }, { code: pattern }] }).select("_id").limit(100).lean(),
        ]);
        const ids = clients.map((row) => row._id);
        const areaIds = areas.map((row) => row._id);
        booking.$or = [
            { containerNumber: pattern }, { bookingReference: pattern }, { bookingNumber: pattern },
            { legacyRegistrationNumber: pattern }, { blNumber: pattern }, { assignedSlotNumber: pattern },
            { shippingLine: pattern },
            ...(ids.length ? [{ client: { $in: ids } }] : []),
            ...(areaIds.length ? [{ assignedArea: { $in: areaIds } }] : []),
        ];
        legacy.$or = [
            { containerNumber: pattern }, { bookingNumber: pattern }, { blNumber: pattern },
            { slotNumber: pattern }, { shippingLine: pattern },
            ...(ids.length ? [{ client: { $in: ids } }] : []),
            ...(areaIds.length ? [{ area: { $in: areaIds } }] : []),
        ];
    }
    return { booking, legacy };
};

const listStoredContainers = async (req, res) => {
    const params = req.query || {};
    // Accept scalar query parameters only; do not allow Express nested-query
    // objects to become MongoDB filter operators.
    const scalarKeys = ["areaId", "blockId", "clientId", "status", "search", "loadStatus", "rateType", "source", "recordSource", "page", "limit", "pageSize", "visualizationLimit"];
    if (scalarKeys.some((key) => params[key] != null && typeof params[key] !== "string" && typeof params[key] !== "number")) {
        return res.status(400).json({ success: false, message: "Invalid Storage Monitoring filter parameters." });
    }
    const source = ["booking", "legacy"].includes(String(params.source)) ? String(params.source) : "all";
    if (bool(params.visualizationOnly)) {
        if (!params.areaId) return res.status(400).json({ success: false, message: "Choose a yard area to display its 3D layout." });
        const visual = await loadVisualization({ areaId: params.areaId, source, requestedLimit: params.visualizationLimit });
        return res.json({ success: true, storageApiVersion: 6, ...visual });
    }
    const filters = await buildFilters(params);
    const [bookingTotal, legacyTotal] = await Promise.all([
        source === "legacy" ? 0 : Booking.countDocuments(filters.booking),
        source === "booking" ? 0 : InventoryContainer.countDocuments(filters.legacy),
    ]);
    const pagination = planStoragePage({
        requestedPage: params.page,
        limit: params.limit || params.pageSize,
        bookingTotal,
        legacyTotal,
    });
    const [bookingRows, legacyRows] = await Promise.all([
        pagination.booking.limit ? Booking.find(filters.booking).select(BOOKING_FIELDS)
            .sort({ updatedAt: -1, _id: -1 }).skip(pagination.booking.skip).limit(pagination.booking.limit)
            .populate("client", "name companyName")
            .populate("assignedArea", "name code").populate("assignedBlock", "name code").lean() : [],
        pagination.legacy.limit ? InventoryContainer.find(filters.legacy).select(LEGACY_FIELDS)
            .sort({ createdAt: -1, _id: -1 }).skip(pagination.legacy.skip).limit(pagination.legacy.limit)
            .populate("client", "name companyName")
            .populate("area", "name code").populate("block", "name code").lean() : [],
    ]);
    const containers = [...bookingRows.map(safeBooking), ...legacyRows.map(safeLegacy)];
    // Never report a nonzero count with an empty page. This historically
    // happened on V3 when $unionWith compared ObjectId fields to raw strings.
    // V5 exclusively uses Mongoose find() queries, which cast IDs correctly.
    if (pagination.total > 0 && containers.length === 0) {
        console.error("Storage Monitoring pagination mismatch", {
            requestedPage: params.page,
            effectivePage: pagination.page,
            limit: pagination.limit,
            bookingTotal, legacyTotal,
            bookingReturned: bookingRows.length,
            legacyReturned: legacyRows.length,
        });
        return res.status(503).json({ success: false, message: "Unable to load stored containers. Please try again." });
    }
    const output = {
        success: true,
        containers,
        pagination: {
            page: pagination.page, currentPage: pagination.page,
            limit: pagination.limit, perPage: pagination.limit,
            total: pagination.total, totalPages: pagination.totalPages,
        },
        source, storageApiVersion: 6,
    };
    // Retain V3's combined-response interface for older clients; the new admin
    // uses visualizationOnly so this extra work never runs on page navigation.
    if (bool(params.includeVisualization) && params.areaId) {
        Object.assign(output, await loadVisualization({ areaId: params.areaId, source, requestedLimit: params.visualizationLimit }));
    }
    return res.json(output);
};

module.exports = { listStoredContainers, planStoragePage, loadVisualization, buildFilters };
