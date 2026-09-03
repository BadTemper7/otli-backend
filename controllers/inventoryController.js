"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignInventoryContainer = exports.createLegacyInventoryContainer = exports.listInventoryClients = exports.listInventoryContainers = void 0;
const InventoryContainer_js_1 = __importDefault(require("../models/InventoryContainer.js"));
const Booking_js_1 = __importDefault(require("../models/Booking.js"));
const PreAdvice_js_1 = __importDefault(require("../models/PreAdvice.js"));
const User_js_1 = __importDefault(require("../models/User.js"));
const YardArea_js_1 = __importDefault(require("../models/YardArea.js"));
const YardBlock_js_1 = __importDefault(require("../models/YardBlock.js"));
const socket_js_1 = require("../socket/socket.js");
const bookingController_js_1 = require("./bookingController.js");
const bookingNumber_js_1 = require("../utils/bookingNumber.js");
const localFileStorage_js_1 = require("../utils/localFileStorage.js");
const notificationService_js_1 = require("../utils/notificationService.js");
const toNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};
const normalizeRateType = (value) => String(value || "").toLowerCase() === "international" ? "international" : "local";
const normalizeContainerNumber = (value = "") => String(value).toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
const getInventoryGateOutSchedule = (booking = {}, asOf = new Date()) => {
    const scheduledAt = booking.outDate ? new Date(booking.outDate) : null;
    const gracePeriodMinutes = Math.max(Number(booking.gateOutGracePeriodMinutes ?? process.env.GATE_OUT_GRACE_PERIOD_MINUTES ?? 120) || 0, 0);
    const overstayStartedAt = scheduledAt && !Number.isNaN(scheduledAt.getTime())
        ? new Date(scheduledAt.getTime() + gracePeriodMinutes * 60 * 1000)
        : null;
    const approvedAndInside = ["gate_out_approved", "gate_out_reversal_requested"].includes(booking.status) && !booking.releasedAt;
    const isOverstaying = Boolean(approvedAndInside && overstayStartedAt && asOf.getTime() > overstayStartedAt.getTime());
    return {
        gateOutGracePeriodMinutes: gracePeriodMinutes,
        gateOutOverstayStartedAt: overstayStartedAt,
        gateOutScheduleStatus: booking.releasedAt
            ? "released"
            : isOverstaying
                ? "overstaying"
                : approvedAndInside
                    ? "awaiting_release"
                    : scheduledAt
                        ? "scheduled"
                        : "not_scheduled",
        isOverstaying,
    };
};
const parseJsonArray = (value) => {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return String(value).split(",").map((item) => item.trim()).filter(Boolean);
    }
};
const buildLegacyReference = async () => {
    const now = new Date();
    const dateCode = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const prefix = `LEG-${dateCode}-`;
    let sequence = await Booking_js_1.default.countDocuments({ legacyRegistrationNumber: { $regex: `^${prefix}` } }) + 1;
    while (true) {
        const value = `${prefix}${String(sequence).padStart(5, "0")}`;
        if (!(await Booking_js_1.default.exists({ $or: [{ legacyRegistrationNumber: value }, { bookingReference: value }] }))) return value;
        sequence += 1;
    }
};
const getYardCapacityUsage = (containerSize, yardContainerSize = 20) => {
    const size = Number(containerSize) || 20;
    const yardSize = Number(yardContainerSize) || 20;
    if (yardSize === 20) {
        if (size === 40) return 2;
        return 1;
    }
    if (size === 20) return 0.5;
    return 1;
};
const getSlotKey = (bay, row, tier) => `${Number(bay) || 1}-${Number(row) || 1}-${Number(tier) || 1}`;
const getReservedSlotKeys = ({ bay, row, tier, containerSize, yardContainerSize }) => {
    const firstBay = Number(bay) || 1;
    const keys = [getSlotKey(firstBay, row, tier)];
    if (Number(containerSize) === 40 && Number(yardContainerSize) === 20) {
        keys.push(getSlotKey(firstBay + 1, row, tier));
    }
    return keys;
};
const getBlockOccupancySnapshot = async (block) => {
    const [otherInventory, activeBookings, confirmedPreAdvices] = await Promise.all([
        InventoryContainer_js_1.default.find({ block: block._id, status: { $ne: "released" } }).select("containerSize bay row tier"),
        Booking_js_1.default.find({
            assignedBlock: block._id,
            status: { $in: ["approved_area_assigned", "gate_in_approved", "stored_in_assigned_area", "gate_out_requested", "gate_out_approved", "gate_out_reversal_requested"] },
        }).select("containerSize assignedBay assignedRow assignedTier"),
        PreAdvice_js_1.default.find({ plannedBlock: block._id, status: "confirmed" }).select("containerSize plannedBay plannedRow plannedTier"),
    ]);
    const occupiedKeys = new Set([
        ...otherInventory.flatMap((item) => getReservedSlotKeys({ bay: item.bay, row: item.row, tier: item.tier, containerSize: item.containerSize, yardContainerSize: block.containerSize })),
        ...activeBookings.flatMap((item) => getReservedSlotKeys({ bay: item.assignedBay, row: item.assignedRow, tier: item.assignedTier, containerSize: item.containerSize, yardContainerSize: block.containerSize })),
        ...confirmedPreAdvices.flatMap((item) => getReservedSlotKeys({ bay: item.plannedBay, row: item.plannedRow, tier: item.plannedTier, containerSize: item.containerSize, yardContainerSize: block.containerSize })),
    ]);
    const usedCapacity = [...otherInventory, ...activeBookings, ...confirmedPreAdvices].reduce((total, item) => total + getYardCapacityUsage(item.containerSize, block.containerSize), 0);
    return { occupiedKeys, usedCapacity };
};
const validateSelectedYardLocation = async ({ area, blockId, bay, row, tier, containerSize }) => {
    if (!blockId || !bay || !row || !tier) {
        throw Object.assign(new Error("Select an available yard block, bay, row, and tier."), { statusCode: 400 });
    }
    const block = await YardBlock_js_1.default.findById(blockId);
    if (!block || String(block.area) !== String(area._id)) {
        throw Object.assign(new Error("The selected yard block does not belong to this yard area."), { statusCode: 404 });
    }
    if (!["active", "full"].includes(block.status || "active")) {
        throw Object.assign(new Error("Containers can only be placed in an active yard block."), { statusCode: 400 });
    }
    const nextBay = Math.max(Math.trunc(toNumber(bay, 0)), 1);
    const nextRow = Math.max(Math.trunc(toNumber(row, 0)), 1);
    const nextTier = Math.max(Math.trunc(toNumber(tier, 0)), 1);
    const bayCount = Math.max(Number(block.bayCount) || 1, 1);
    const rowCount = Math.max(Number(block.rowCount) || 1, 1);
    const tierCount = Math.max(Number(block.tierCount) || 1, 1);
    if (nextBay > bayCount || nextRow > rowCount || nextTier > tierCount) {
        throw Object.assign(new Error(`Location is outside block limits. Max bay ${bayCount}, row ${rowCount}, tier ${tierCount}.`), { statusCode: 400 });
    }
    const requestedKeys = getReservedSlotKeys({
        bay: nextBay,
        row: nextRow,
        tier: nextTier,
        containerSize: Number(containerSize),
        yardContainerSize: block.containerSize,
    });
    if (requestedKeys.length === 2 && nextBay + 1 > bayCount) {
        throw Object.assign(new Error("A 40ft container needs two adjacent 20ft TEU slots. Select another available slot."), { statusCode: 400 });
    }
    const { occupiedKeys, usedCapacity } = await getBlockOccupancySnapshot(block);
    if (requestedKeys.some((key) => occupiedKeys.has(key))) {
        throw Object.assign(new Error("The selected yard slot is no longer available. Refresh the available slots and choose another one."), { statusCode: 409 });
    }
    const requiredCapacity = getYardCapacityUsage(Number(containerSize), block.containerSize);
    if (usedCapacity + requiredCapacity > Number(block.teuSlots || 0)) {
        const unit = Number(block.containerSize) === 20 ? "TEU" : "FEU";
        throw Object.assign(new Error(`The selected yard block does not have enough available ${unit} capacity.`), { statusCode: 409 });
    }
    return { block, bay: nextBay, row: nextRow, tier: nextTier };
};

const recalculateBlockOccupancy = async (blockId) => {
    if (!blockId)
        return;
    const [block, containers, bookingContainers] = await Promise.all([
        YardBlock_js_1.default.findById(blockId).select("containerSize"),
        InventoryContainer_js_1.default.find({ block: blockId, status: { $ne: "released" } }).select("containerSize"),
        Booking_js_1.default.find({
            assignedBlock: blockId,
            status: { $in: ["approved_area_assigned", "gate_in_approved", "stored_in_assigned_area", "gate_out_requested", "gate_out_approved", "gate_out_reversal_requested"] },
        }).select("containerSize"),
    ]);
    if (!block)
        return;
    const occupiedSlots = [...containers, ...bookingContainers].reduce((total, container) => total + getYardCapacityUsage(container.containerSize, block.containerSize), 0);
    await YardBlock_js_1.default.findByIdAndUpdate(blockId, {
        occupiedSlots: Math.round(occupiedSlots * 100) / 100,
    });
};
const safeBookingContainer = (booking) => {
    const doc = booking.toObject ? booking.toObject() : booking;
    const client = doc.client || {};
    const area = doc.assignedArea || null;
    const block = doc.assignedBlock || null;
    const legacyRegisteredBy = doc.legacyRegisteredBy || null;
    const gateOutSchedule = getInventoryGateOutSchedule(doc);
    return {
        id: String(doc._id),
        source: "booking",
        recordSource: doc.recordSource || "client_booking",
        legacyRegistrationNumber: doc.legacyRegistrationNumber || "",
        legacyRegisteredAt: doc.legacyRegisteredAt,
        legacyRegisteredByName: legacyRegisteredBy?.name || "",
        legacyRegistrationReason: doc.legacyRegistrationReason || "",
        historicalGateInDateType: doc.historicalGateInDateType || "unknown",
        historicalSourceReference: doc.historicalSourceReference || "",
        billingStartMethod: doc.billingStartMethod || "migration_date",
        migrationDate: doc.migrationDate,
        openingBalanceAmount: Number(doc.openingBalanceAmount) || 0,
        openingCreditAmount: Number(doc.openingCreditAmount) || 0,
        bookingReference: doc.bookingReference,
        preAdvice: "",
        gateIn: "",
        preAdviceNumber: "",
        gateInNumber: "",
        client: client?._id ? String(client._id) : doc.client ? String(doc.client) : "",
        clientName: client.companyName || client.name || "",
        containerNumber: doc.containerNumber,
        containerSize: doc.containerSize,
        containerType: doc.containerType,
        containerStatus: doc.containerLoadStatus,
        containerLoadStatus: doc.containerLoadStatus,
        rateType: normalizeRateType(doc.rateType),
        shippingLine: doc.shippingLine,
        bookingNumber: doc.bookingNumber || "",
        blNumber: doc.blNumber || "",
        customerName: client.companyName || client.name || "",
        status: doc.status === "completed_gate_out_done" ? "released" : doc.status === "gate_in_approved" ? "gate_in_approved" : "in_yard",
        bookingStatus: doc.status,
        billingStatus: doc.billingStatus,
        area: area?._id ? String(area._id) : doc.assignedArea ? String(doc.assignedArea) : "",
        areaName: area?.name || "",
        block: block?._id ? String(block._id) : doc.assignedBlock ? String(doc.assignedBlock) : "",
        blockName: block?.name || "",
        blockCode: block?.code || "",
        bay: Number(doc.assignedBay) || 1,
        row: Number(doc.assignedRow) || 1,
        tier: Number(doc.assignedTier) || 1,
        slotNumber: doc.assignedSlotNumber || "",
        x: 40,
        y: 40,
        width: 92,
        height: 46,
        gateInApprovedAt: doc.gateInApprovedAt,
        storedAt: doc.storedAt,
        inventoryEnteredAt: doc.gateInApprovedAt || doc.storedAt || doc.storageStartDate || doc.updatedAt || doc.createdAt,
        storageStartDate: doc.storageStartDate,
        inDate: doc.inDate || doc.expectedArrivalDate,
        outDate: doc.outDate,
        gateOutGracePeriodMinutes: gateOutSchedule.gateOutGracePeriodMinutes,
        gateOutScheduleStatus: gateOutSchedule.gateOutScheduleStatus,
        gateOutOverstayStartedAt: gateOutSchedule.gateOutOverstayStartedAt,
        isOverstaying: gateOutSchedule.isOverstaying,
        containerCondition: doc.physicalCondition || "",
        truckPlateNumber: doc.truckPlateNumber || "",
        driverName: doc.driverName || "",
        damageRemarks: doc.inspectionRemarks || "",
        documents: doc.documents || [],
        sealNumber: doc.sealNumber || "",
        sealIntact: doc.sealIntact || "",
        driverLicenseNumber: doc.driverLicenseNumber || "",
        hauler: doc.hauler || "",
        gateInConditions: doc.gateInConditions || [],
        gateInConditionOther: doc.gateInConditionOther || "",
        billingSubtotal: Number(doc.billingSubtotal) || 0,
        vatAmount: Number(doc.vatAmount) || 0,
        billingTotal: Number(doc.billingTotal) || 0,
        paymentBalanceDue: Number(doc.paymentBalanceDue ?? doc.paymentAmount) || 0,
        assignedAt: doc.assignedAt,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
};
const safeContainer = (container) => {
    const doc = container.toObject ? container.toObject() : container;
    const client = doc.client || {};
    const area = doc.area || null;
    const block = doc.block || null;
    return {
        id: String(doc._id),
        preAdvice: doc.preAdvice?._id ? String(doc.preAdvice._id) : String(doc.preAdvice),
        gateIn: doc.gateIn?._id ? String(doc.gateIn._id) : String(doc.gateIn),
        preAdviceNumber: doc.preAdvice?.preAdviceNumber || "",
        gateInNumber: doc.gateIn?.gateInNumber || "",
        client: client?._id ? String(client._id) : String(doc.client),
        clientName: client.companyName || client.name || doc.customerName || "",
        containerNumber: doc.containerNumber,
        containerSize: doc.containerSize,
        containerType: doc.containerType,
        containerStatus: doc.containerStatus,
        containerLoadStatus: doc.containerStatus,
        rateType: normalizeRateType(doc.rateType),
        shippingLine: doc.shippingLine,
        bookingNumber: doc.bookingNumber || "",
        blNumber: doc.blNumber || "",
        customerName: doc.customerName || "",
        status: doc.status,
        area: area?._id ? String(area._id) : doc.area ? String(doc.area) : "",
        areaName: area?.name || "",
        block: block?._id ? String(block._id) : doc.block ? String(doc.block) : "",
        blockName: block?.name || "",
        blockCode: block?.code || "",
        bay: Number(doc.bay) || 1,
        row: Number(doc.row) || 1,
        tier: Number(doc.tier) || 1,
        slotNumber: doc.slotNumber || "",
        x: Number(doc.x) || 40,
        y: Number(doc.y) || 40,
        width: Number(doc.width) || 92,
        height: Number(doc.height) || 46,
        gateInApprovedAt: doc.gateIn?.completedAt || null,
        storedAt: doc.storageStartDate || null,
        inventoryEnteredAt: doc.gateIn?.completedAt || doc.storageStartDate || doc.createdAt || doc.updatedAt,
        storageStartDate: doc.storageStartDate,
        containerCondition: doc.containerCondition || "",
        truckPlateNumber: doc.truckPlateNumber || "",
        driverName: doc.driverName || "",
        damageRemarks: doc.damageRemarks || "",
        assignedAt: doc.assignedAt,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
};
const listInventoryClients = async (req, res) => {
    const clients = await User_js_1.default.find({
        userType: "client",
        status: { $in: ["verified", "active"] },
    }).select("name companyName email phoneNumber status").sort({ companyName: 1, name: 1 }).limit(500);
    return res.json({
        success: true,
        clients: clients.map((client) => ({
            id: String(client._id),
            name: client.companyName || client.name || client.email,
            contactName: client.name || "",
            email: client.email || "",
            phoneNumber: client.phoneNumber || "",
            status: client.status,
        })),
    });
};
exports.listInventoryClients = listInventoryClients;
const createLegacyInventoryContainer = async (req, res) => {
    const {
        clientId,
        containerNumber,
        containerSize,
        containerType,
        containerLoadStatus,
        rateType,
        shippingLine,
        sealNumber,
        sealIntact,
        truckPlateNumber,
        driverName,
        driverLicenseNumber,
        hauler,
        scheduledDateIn,
        scheduledTimeIn,
        scheduledDateTimeIn,
        historicalGateInDate,
        historicalGateInDateType,
        historicalSourceReference,
        areaId,
        blockId,
        bay,
        row,
        tier,
        billingStartMethod,
        isVatApplicable,
        openingBalanceAmount,
        openingCreditAmount,
        legacyRegistrationReason,
        inspectionRemarks,
        gateInConditionOther,
    } = req.body;
    const required = [containerNumber, containerSize, containerType, containerLoadStatus, rateType, scheduledDateIn, scheduledTimeIn, shippingLine, areaId, blockId, bay, row, tier];
    if (required.some((value) => !String(value || "").trim())) {
        return res.status(400).json({
            success: false,
            message: "Complete the required details and select an available yard slot before registering the container.",
        });
    }
    if (![20, 40].includes(Number(containerSize))) {
        return res.status(400).json({ success: false, message: "Container size must be 20ft or 40ft." });
    }
    if (!["empty", "laden"].includes(String(containerLoadStatus).toLowerCase())) {
        return res.status(400).json({ success: false, message: "Select whether the container is Empty or Laden." });
    }
    if (!["local", "international"].includes(String(rateType).toLowerCase())) {
        return res.status(400).json({ success: false, message: "Select Local or International rate classification." });
    }
    let client = null;
    if (String(clientId || "").trim()) {
        client = await User_js_1.default.findOne({ _id: clientId, userType: "client", status: { $in: ["verified", "active"] } });
        if (!client) {
            return res.status(404).json({ success: false, message: "Verified client account not found." });
        }
    }
    const normalizedContainer = normalizeContainerNumber(containerNumber);
    if (!normalizedContainer) {
        return res.status(400).json({ success: false, message: "Enter a valid container number." });
    }
    const [activeBooking, activeInventory] = await Promise.all([
        Booking_js_1.default.findOne({ containerNumber: normalizedContainer, status: { $nin: ["rejected", "cancelled", "completed_gate_out_done"] } }),
        InventoryContainer_js_1.default.findOne({ containerNumber: normalizedContainer, status: { $ne: "released" } }),
    ]);
    if (activeBooking || activeInventory) {
        return res.status(409).json({ success: false, message: "This container number already has an active record." });
    }
    const area = await YardArea_js_1.default.findById(areaId);
    if (!area) {
        return res.status(404).json({ success: false, message: "The selected yard area is invalid." });
    }
    let location;
    try {
        location = await validateSelectedYardLocation({ area, blockId, bay, row, tier, containerSize: Number(containerSize) });
    }
    catch (error) {
        return res.status(error.statusCode || 400).json({ success: false, message: error.message || "The selected yard slot is unavailable." });
    }
    const block = location.block;
    const nextBay = location.bay;
    const nextRow = location.row;
    const nextTier = location.tier;
    const migrationDate = new Date();
    const dateType = "exact";
    const fallbackDateTime = `${String(scheduledDateIn).trim()}T${String(scheduledTimeIn).trim()}:00+08:00`;
    const historicalDate = new Date(scheduledDateTimeIn || historicalGateInDate || fallbackDateTime);
    if (Number.isNaN(historicalDate.getTime())) {
        return res.status(400).json({ success: false, message: "Provide a valid Scheduled Date In and Scheduled Time In." });
    }
    if (historicalDate > migrationDate) {
        return res.status(400).json({ success: false, message: "Scheduled Date In and Time In cannot be in the future for an existing stored container." });
    }
    const startMethod = billingStartMethod === "historical_gate_in" ? "historical_gate_in" : "migration_date";
    const storageStartDate = startMethod === "historical_gate_in" ? historicalDate : migrationDate;
    const legacyRegistrationNumber = await buildLegacyReference();
    const bookingNumber = await (0, bookingNumber_js_1.buildBookingNumber)();
    const documents = [];
    if (req.file) {
        const stored = await (0, localFileStorage_js_1.saveUploadedFile)({
            file: req.file,
            clientId: client?._id || req.user._id,
            clientName: client?.companyName || client?.name || "Unassigned Legacy Container",
            category: "legacy-container",
            prefix: legacyRegistrationNumber,
        });
        documents.push({
            type: "legacySupportingDocument",
            label: "Legacy Container Supporting Document",
            fileName: req.file.originalname,
            url: stored.url,
            secureUrl: stored.secureUrl,
            publicId: stored.publicId,
            resourceType: stored.resourceType,
            mimeType: req.file.mimetype,
            sizeBytes: stored.sizeBytes,
            uploadedAt: migrationDate,
        });
    }
    const conditions = parseJsonArray(req.body.gateInConditions).map((item) => String(item).trim().toUpperCase()).filter(Boolean);
    const openingBalance = Math.max(Number(openingBalanceAmount) || 0, 0);
    const openingCredit = Math.max(Number(openingCreditAmount) || 0, 0);
    const additionalBillingCharges = openingBalance > 0 ? [{
        rate: null,
        chargeCode: "LEGACY_OPENING_BALANCE",
        source: "legacy_opening_balance",
        description: "Opening balance from records before system migration",
        quantity: 1,
        rateAmount: openingBalance,
        amount: openingBalance,
        notes: historicalSourceReference || legacyRegistrationReason || "Existing container registration",
        addedBy: req.user._id,
        addedAt: migrationDate,
    }] : [];
    const paymentTransactions = openingCredit > 0 ? [{
        amount: openingCredit,
        subtotal: openingCredit,
        isVatApplicable: false,
        vatRate: 0,
        vatAmount: 0,
        grossTotal: openingCredit,
        lineItems: [],
        paymentTypeSnapshot: { type: "legacy", name: "Opening Credit" },
        referenceNumber: historicalSourceReference || legacyRegistrationNumber,
        paymentDate: migrationDate,
        remarks: "Opening credit carried forward during legacy container registration.",
        proofs: documents,
        submittedAt: migrationDate,
        approvedAt: migrationDate,
        approvedBy: req.user._id,
        receiptNumber: "",
        receiptType: "acknowledgement_receipt",
        cashReceived: 0,
        changeAmount: 0,
        source: "legacy",
        archivedAt: migrationDate,
    }] : [];
    const booking = await Booking_js_1.default.create({
        client: client?._id || null,
        recordSource: "legacy_migration",
        legacyRegistrationNumber,
        legacyRegisteredAt: migrationDate,
        legacyRegisteredBy: req.user._id,
        legacyRegistrationReason: String(legacyRegistrationReason || "Existing container registered manually from pre-system inventory records.").trim(),
        historicalGateInDateType: dateType,
        historicalSourceReference: String(historicalSourceReference || "").trim(),
        billingStartMethod: startMethod,
        migrationDate,
        openingBalanceAmount: openingBalance,
        openingCreditAmount: openingCredit,
        bookingReference: legacyRegistrationNumber,
        bookingNumber,
        qrCodeValue: `OTLI:LEGACY:${bookingNumber}:${normalizedContainer}`,
        containerNumber: normalizedContainer,
        actualContainerNumber: normalizedContainer,
        containerSize: Number(containerSize),
        containerType,
        containerLoadStatus: String(containerLoadStatus).toLowerCase(),
        rateType: normalizeRateType(rateType),
        serviceType: "container_yard",
        shippingLine: String(shippingLine).trim(),
        expectedArrivalDate: historicalDate,
        inDate: historicalDate,
        documents,
        status: "stored_in_assigned_area",
        billingStatus: "unpaid",
        isVatApplicable: String(isVatApplicable || "true").toLowerCase() !== "false",
        submittedAt: migrationDate,
        approvedAt: migrationDate,
        approvedBy: req.user._id,
        assignedArea: area._id,
        assignedBlock: block._id,
        assignedBay: nextBay,
        assignedRow: nextRow,
        assignedTier: nextTier,
        assignedSlotNumber: `${block.code}-B${nextBay}-R${nextRow}-T${nextTier}`,
        assignedAt: migrationDate,
        assignedBy: req.user._id,
        gateInApprovedAt: historicalDate,
        gateInApprovedBy: req.user._id,
        gateInPassNumber: "",
        gateInConditions: conditions.length ? conditions : ["GOOD"],
        gateInConditionOther: String(gateInConditionOther || "").trim(),
        physicalCondition: conditions.length ? conditions.join(", ") : "GOOD",
        sealNumber: String(sealNumber || "").trim(),
        sealIntact: ["yes", "no"].includes(String(sealIntact || "").toLowerCase()) ? String(sealIntact).toLowerCase() : "",
        truckPlateNumber: String(truckPlateNumber || "").trim(),
        driverName: String(driverName || "").trim(),
        driverLicenseNumber: String(driverLicenseNumber || "").trim(),
        hauler: String(hauler || "").trim(),
        inspectionRemarks: String(inspectionRemarks || "").trim(),
        storedAt: migrationDate,
        storedBy: req.user._id,
        storageStartDate,
        additionalBillingCharges,
        approvedPaymentAmount: openingCredit,
        paymentTransactions,
        statusHistory: [{
            status: "stored_in_assigned_area",
            billingStatus: "unpaid",
            remarks: `Existing container registered as a legacy migration record. Historical Gate-In date quality: ${dateType}. Billing begins from ${startMethod === "historical_gate_in" ? "the historical Gate-In date" : "the migration date"}.`,
            changedBy: req.user._id,
            changedAt: migrationDate,
        }],
    });
    const billingResult = await (0, bookingController_js_1.computeBookingBilling)(booking, { asOf: migrationDate, persist: true });
    if (openingCredit > 0 && Number(booking.paymentBalanceDue || 0) <= 0) booking.billingStatus = "paid_approved";
    booking.statusHistory.push({
        status: booking.status,
        billingStatus: booking.billingStatus,
        remarks: `Legacy registration billing initialized at PHP ${Number(billingResult.total || 0).toLocaleString()} with PHP ${openingCredit.toLocaleString()} opening credit and PHP ${Number(booking.paymentBalanceDue || 0).toLocaleString()} balance due.`,
        changedBy: req.user._id,
        changedAt: new Date(),
    });
    await booking.save();
    await recalculateBlockOccupancy(block._id);
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    await booking.populate("legacyRegisteredBy", "name");
    (0, socket_js_1.emitToAdmins)("inventory:legacy_container_created", { id: String(booking._id), bookingReference: booking.bookingReference, containerNumber: booking.containerNumber });
    (0, socket_js_1.emitToAdmins)("storage:updated", { id: String(booking._id), containerNumber: booking.containerNumber });
    (0, socket_js_1.emitToAdmins)("yard:slot_reserved", { id: String(booking._id), containerNumber: booking.containerNumber, blockId: String(block._id) });
    if (client?._id) {
        (0, socket_js_1.emitToUser)(client._id, "booking:legacy_registered", { id: String(booking._id), bookingReference: booking.bookingReference, containerNumber: booking.containerNumber });
        await (0, notificationService_js_1.createClientNotification)({
            recipient: client._id,
            type: "booking",
            title: "Existing container added to inventory",
            message: `Container ${booking.containerNumber} was registered in the OTLI inventory from historical company records.`,
            booking: booking._id,
            bookingReference: booking.bookingReference,
            containerNumber: booking.containerNumber,
            actionPath: "/booking-history",
        });
    }
    return res.status(201).json({
        success: true,
        message: `Existing container registered as ${legacyRegistrationNumber}. Billing computed at PHP ${Number(billingResult.total || 0).toLocaleString()}.`,
        booking: { id: String(booking._id), bookingReference: booking.bookingReference, containerNumber: booking.containerNumber },
    });
};
exports.createLegacyInventoryContainer = createLegacyInventoryContainer;
const INVENTORY_LIST_LIMIT = 1000;
const INVENTORY_QUERY_LIMIT = INVENTORY_LIST_LIMIT + 1;
const listInventoryContainers = async (req, res) => {
    const { areaId, status, clientId, search } = req.query;
    const query = {};
    const bookingQuery = { status: { $in: ["gate_in_approved", "stored_in_assigned_area", "gate_out_requested", "gate_out_approved", "gate_out_reversal_requested"] } };
    if (clientId && clientId !== "all") {
        query.client = clientId;
        bookingQuery.client = clientId;
    }
    if (status && status !== "all")
        query.status = status;
    if (areaId) {
        query.$or = [{ area: areaId }, { area: null }];
        bookingQuery.$or = [{ assignedArea: areaId }, { assignedArea: null }];
    }
    if (search) {
        const term = String(search).trim();
        query.containerNumber = { $regex: term, $options: "i" };
        bookingQuery.$and = [
            ...(bookingQuery.$and || []),
            {
                $or: [
                    { containerNumber: { $regex: term, $options: "i" } },
                    { bookingReference: { $regex: term, $options: "i" } },
                ],
            },
        ];
    }
    const [containers, bookingContainers] = await Promise.all([
        InventoryContainer_js_1.default.find(query)
            .populate("client", "name email companyName")
            .populate("area", "name code")
            .populate("block", "name code")
            .populate("preAdvice", "preAdviceNumber status")
            .populate("gateIn", "gateInNumber status completedAt")
            .sort({ status: 1, createdAt: -1 })
            .limit(INVENTORY_QUERY_LIMIT).lean(),
        Booking_js_1.default.find(bookingQuery)
            .populate("client", "name email companyName")
            .populate("assignedArea", "name code")
            .populate("assignedBlock", "name code")
            .populate("legacyRegisteredBy", "name")
            .sort({ gateInApprovedAt: -1, storedAt: -1, updatedAt: -1 })
            .limit(INVENTORY_QUERY_LIMIT).lean(),
    ]);
    const combined = [...bookingContainers.map(safeBookingContainer), ...containers.map((container) => ({ ...safeContainer(container), source: "pre_advice" }))].sort((a, b) => {
        const aWaitingStorage = a.source === "booking" && a.bookingStatus === "gate_in_approved" ? 0 : 1;
        const bWaitingStorage = b.source === "booking" && b.bookingStatus === "gate_in_approved" ? 0 : 1;
        if (aWaitingStorage !== bWaitingStorage)
            return aWaitingStorage - bWaitingStorage;
        const bEnteredAt = new Date(b.inventoryEnteredAt || b.gateInApprovedAt || b.storedAt || b.createdAt || 0).getTime();
        const aEnteredAt = new Date(a.inventoryEnteredAt || a.gateInApprovedAt || a.storedAt || a.createdAt || 0).getTime();
        return bEnteredAt - aEnteredAt;
    });
    const limited = combined.slice(0, INVENTORY_LIST_LIMIT);
    return res.json({
        success: true,
        containers: limited,
        limit: INVENTORY_LIST_LIMIT,
        returned: limited.length,
        truncated: combined.length > INVENTORY_LIST_LIMIT,
    });
};
exports.listInventoryContainers = listInventoryContainers;
const assignInventoryContainer = async (req, res) => {
    const { areaId, blockId, bay, row, tier, slotNumber, x, y, width, height } = req.body;
    const container = await InventoryContainer_js_1.default.findById(req.params.id);
    if (!container) {
        return res.status(404).json({ success: false, message: "Inventory container not found." });
    }
    if (!["awaiting_yard_assignment", "in_yard", "hold"].includes(container.status)) {
        return res.status(400).json({ success: false, message: `Container cannot be assigned from ${container.status} status.` });
    }
    if (!areaId || !blockId) {
        return res.status(400).json({ success: false, message: "Area and block are required before placing the container." });
    }
    const [area, block] = await Promise.all([YardArea_js_1.default.findById(areaId), YardBlock_js_1.default.findById(blockId)]);
    if (!area) {
        return res.status(404).json({ success: false, message: "Yard area not found." });
    }
    if (!block || String(block.area) !== String(area._id)) {
        return res.status(404).json({ success: false, message: "Selected block does not belong to this area." });
    }
    if (!["active", "full"].includes(block.status)) {
        return res.status(400).json({ success: false, message: "Container can only be placed in active blocks." });
    }
    const nextBay = Math.max(toNumber(bay, 1), 1);
    const nextRow = Math.max(toNumber(row, 1), 1);
    const nextTier = Math.max(toNumber(tier, 1), 1);
    if (nextBay > block.bayCount || nextRow > block.rowCount || nextTier > block.tierCount) {
        return res.status(400).json({
            success: false,
            message: `Location is outside block limits. Max bay ${block.bayCount}, row ${block.rowCount}, tier ${block.tierCount}.`,
        });
    }
    const autoSlotNumber = slotNumber || `${block.code}-B${nextBay}-R${nextRow}-T${nextTier}`;
    const requestedSlotKeys = getReservedSlotKeys({ bay: nextBay, row: nextRow, tier: nextTier, containerSize: container.containerSize, yardContainerSize: block.containerSize });
    if (requestedSlotKeys.length === 2 && nextBay + 1 > Number(block.bayCount || 1)) {
        return res.status(400).json({ success: false, message: "A 40ft container needs two adjacent 20ft TEU slots. Select a bay with an available next bay." });
    }
    const [otherInventory, activeBookings] = await Promise.all([
        InventoryContainer_js_1.default.find({ _id: { $ne: container._id }, block: block._id, status: { $ne: "released" } }).select("containerSize bay row tier"),
        Booking_js_1.default.find({
            assignedBlock: block._id,
            status: { $in: ["approved_area_assigned", "gate_in_approved", "stored_in_assigned_area", "gate_out_requested", "gate_out_approved", "gate_out_reversal_requested"] },
        }).select("containerSize assignedBay assignedRow assignedTier"),
    ]);
    const occupiedKeys = new Set([
        ...otherInventory.flatMap((item) => getReservedSlotKeys({ bay: item.bay, row: item.row, tier: item.tier, containerSize: item.containerSize, yardContainerSize: block.containerSize })),
        ...activeBookings.flatMap((item) => getReservedSlotKeys({ bay: item.assignedBay, row: item.assignedRow, tier: item.assignedTier, containerSize: item.containerSize, yardContainerSize: block.containerSize })),
    ]);
    if (requestedSlotKeys.some((key) => occupiedKeys.has(key))) {
        return res.status(409).json({ success: false, message: "One or both required yard slots are already occupied or reserved." });
    }
    const usedCapacity = [...otherInventory, ...activeBookings].reduce((total, item) => total + getYardCapacityUsage(item.containerSize, block.containerSize), 0);
    const incomingCapacity = getYardCapacityUsage(container.containerSize, block.containerSize);
    if (usedCapacity + incomingCapacity > Number(block.teuSlots)) {
        const unit = Number(block.containerSize) === 20 ? "TEU" : "FEU";
        return res.status(400).json({ success: false, message: `Selected yard area does not have enough available ${unit} capacity.` });
    }
    const previousBlockId = container.block ? String(container.block) : "";
    container.area = area._id;
    container.block = block._id;
    container.bay = nextBay;
    container.row = nextRow;
    container.tier = nextTier;
    container.slotNumber = autoSlotNumber;
    container.x = Math.max(toNumber(x, container.x || 40), 0);
    container.y = Math.max(toNumber(y, container.y || 40), 0);
    container.width = Math.max(toNumber(width, container.width || 92), 60);
    container.height = Math.max(toNumber(height, container.height || 46), 34);
    container.status = "in_yard";
    container.assignedAt = new Date();
    container.assignedBy = req.user._id;
    await container.save();
    await recalculateBlockOccupancy(block._id);
    if (previousBlockId && previousBlockId !== String(block._id)) {
        await recalculateBlockOccupancy(previousBlockId);
    }
    await container.populate("client", "name email companyName");
    await container.populate("area", "name code");
    await container.populate("block", "name code");
    await container.populate("preAdvice", "preAdviceNumber status");
    await container.populate("gateIn", "gateInNumber status completedAt");
    const payload = safeContainer(container);
    (0, socket_js_1.emitToAdmins)("inventory:container_assigned", payload);
    return res.json({ success: true, message: "Container assigned to yard location.", container: payload });
};
exports.assignInventoryContainer = assignInventoryContainer;
