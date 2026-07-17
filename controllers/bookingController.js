"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBookingSummary = exports.getPublicBookingByNumber = exports.relocateBooking = exports.completeBookingGateOut = exports.approveBookingGateOut = exports.requestBookingGateOut = exports.rejectBookingPayment = exports.approveBookingPayment = exports.submitBookingPayment = exports.deleteBookingAdditionalCharge = exports.addBookingAdditionalCharge = exports.updateBookingBillingOperation = exports.markBookingStored = exports.approveBookingGateIn = exports.rejectBooking = exports.approveBooking = exports.getAdminBooking = exports.listAdminBookings = exports.getClientBooking = exports.listClientBookings = exports.resubmitClientBooking = exports.createClientBooking = exports.getYardBlockSlots = exports.computeBookingBilling = void 0;
const Booking_js_1 = __importDefault(require("../models/Booking.js"));
const PreAdvice_js_1 = __importDefault(require("../models/PreAdvice.js"));
const InventoryContainer_js_1 = __importDefault(require("../models/InventoryContainer.js"));
const YardArea_js_1 = __importDefault(require("../models/YardArea.js"));
const YardBlock_js_1 = __importDefault(require("../models/YardBlock.js"));
const BillingRate_js_1 = __importDefault(require("../models/BillingRate.js"));
const PaymentType_js_1 = __importDefault(require("../models/PaymentType.js"));
const localFileStorage_js_1 = require("../utils/localFileStorage.js");
const mailer_js_1 = require("../config/mailer.js");
const emailTemplates_js_1 = require("../utils/emailTemplates.js");
const socket_js_1 = require("../socket/socket.js");
const bookingNumber_js_1 = require("../utils/bookingNumber.js");
const ACTIVE_BOOKING_STATUSES = [
    "approved_area_assigned",
    "gate_in_approved",
    "stored_in_assigned_area",
    "gate_out_requested",
    "gate_out_approved",
];
const TERMINAL_BOOKING_STATUSES = ["rejected", "cancelled", "completed_gate_out_done"];
const normalizeContainerNumber = (value = "") => String(value).toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
const toNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};
const toPositive = (value, fallback = 1) => Math.max(toNumber(value, fallback), 1);
const getTeuFactor = (size) => {
    if (Number(size) === 40)
        return 2;
    return 1;
};
const calculateAreaCapacityTeu = ({ lineCount = 1, rowCount = 1, tierCount = 1 }) => {
    const capacity = toPositive(lineCount, 1) * toPositive(rowCount, 1) * toPositive(tierCount, 1);
    return Math.max(Math.round(capacity * 100) / 100, 1);
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
const getYardCapacityUnit = (yardContainerSize) => Number(yardContainerSize) === 20 ? "TEU" : "FEU";
const ensureAreaLocationBlock = async (area) => {
    const existingBlock = await YardBlock_js_1.default.findOne({ area: area._id }).sort({ code: 1, name: 1 });
    if (existingBlock)
        return existingBlock;
    const lineCount = toPositive(area.lineCount, 1);
    const rowCount = toPositive(area.rowCount, 1);
    const tierCount = toPositive(area.tierCount, 1);
    const containerSize = [20, 40].includes(Number(area.containerSize)) ? Number(area.containerSize) : 20;
    const capacityTeu = area.capacityTeu || calculateAreaCapacityTeu({ lineCount, rowCount, tierCount, containerSize });
    return YardBlock_js_1.default.create({
        area: area._id,
        name: area.name,
        code: area.code,
        blockType: "standard",
        bayCount: lineCount,
        rowCount,
        tierCount,
        containerSize,
        teuSlots: Math.max(Number(capacityTeu) || 1, 1),
        occupiedSlots: 0,
        status: area.status === "active" ? "active" : area.status === "maintenance" ? "maintenance" : "inactive",
        notes: "Internal location record created from the yard area for bay, row, and tier tracking.",
    });
};
const bookingPreAdviceDocumentLabels = {
    deliveryOrder: "Delivery Order",
    bookingConfirmation: "Booking Confirmation",
    packingList: "Packing List",
    customsClearance: "Customs Clearance",
    otherDocument: "Other Document",
};
const bookingPaymentDocumentLabels = {
    paymentProof: "Payment Proof",
    otherDocument: "Other Document",
};
const buildSequenceNumber = async (prefix, Model, fieldName) => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const dateCode = `${yyyy}${mm}${dd}`;
    const dayStart = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
    const count = await Model.countDocuments({ createdAt: { $gte: dayStart } });
    const seq = String(count + 1).padStart(5, "0");
    const value = `${prefix}-${dateCode}-${seq}`;
    const exists = await Model.findOne({ [fieldName]: value });
    if (!exists)
        return value;
    return `${value}-${Date.now().toString().slice(-4)}`;
};
const buildPaymentReferenceNumber = async () => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const dateCode = `${yyyy}${mm}${dd}`;
    const dayStart = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
    const count = await Booking_js_1.default.countDocuments({ paymentSubmittedAt: { $gte: dayStart } });
    const seq = String(count + 1).padStart(5, "0");
    const baseValue = `PAY-${dateCode}-${seq}`;
    let value = baseValue;
    let attempt = 1;
    while (await Booking_js_1.default.exists({ paymentReferenceNumber: value })) {
        attempt += 1;
        value = `${baseValue}-${Date.now().toString().slice(-4)}${attempt > 2 ? `-${attempt}` : ""}`;
    }
    return value;
};
const normalizeBillingRateKey = (value) => String(value || "all").trim().toLowerCase();
const normalizeBookingServiceType = () => "container_yard";
const normalizeRateType = () => "local";
const parseBookingDate = (value) => {
    if (!value)
        return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};
const resolveBookingDateRange = (booking = {}) => {
    const inDate = parseBookingDate(booking.inDate || booking.expectedArrivalDate || booking.storageStartDate || booking.storedAt || booking.gateInApprovedAt || booking.createdAt);
    const outDate = parseBookingDate(booking.outDate);
    return { inDate, outDate };
};
const getDateRangeDays = (startValue, endValue) => {
    const start = parseBookingDate(startValue);
    const end = parseBookingDate(endValue);
    if (!start || !end)
        return 0;
    const diffMs = end.getTime() - start.getTime();
    if (!Number.isFinite(diffMs) || diffMs <= 0)
        return 0;
    return Math.max(Math.ceil(diffMs / (24 * 60 * 60 * 1000)), 1);
};
const getStorageDays = (booking, asOf = new Date()) => {
    const { inDate, outDate } = resolveBookingDateRange(booking);
    const plannedDays = getDateRangeDays(inDate, outDate);
    if (plannedDays > 0)
        return plannedDays;
    const start = booking.storageStartDate || booking.storedAt || booking.gateInApprovedAt || booking.createdAt || asOf;
    const diffMs = new Date(asOf).getTime() - new Date(start).getTime();
    if (!Number.isFinite(diffMs) || diffMs <= 0)
        return 1;
    return Math.max(Math.ceil(diffMs / (24 * 60 * 60 * 1000)), 1);
};
const validateBookingDateRange = ({ inDate, outDate, expectedArrivalDate }) => {
    const parsedIn = parseBookingDate(inDate || expectedArrivalDate);
    const hasOutDate = outDate !== undefined && outDate !== null && String(outDate).trim() !== "";
    const parsedOut = hasOutDate ? parseBookingDate(outDate) : null;
    if (!parsedIn) {
        return { valid: false, message: "Please provide a valid In Date." };
    }
    if (hasOutDate && !parsedOut) {
        return { valid: false, message: "Please provide a valid Out Date." };
    }
    if (parsedIn.getMinutes() !== 0 || parsedIn.getSeconds() !== 0 || parsedIn.getMilliseconds() !== 0) {
        return { valid: false, message: "Scheduled Time In must use a whole-hour interval, such as 1:00 or 2:00." };
    }
    if (parsedOut && parsedOut.getTime() <= parsedIn.getTime()) {
        return { valid: false, message: "Out Date must be later than In Date." };
    }
    return { valid: true, inDate: parsedIn, outDate: parsedOut, days: parsedOut ? getDateRangeDays(parsedIn, parsedOut) : 0 };
};
const validateGateOutDate = (booking, outDate) => {
    const parsedIn = parseBookingDate(booking.inDate || booking.expectedArrivalDate || booking.storageStartDate || booking.storedAt || booking.gateInApprovedAt);
    const parsedOut = parseBookingDate(outDate);
    if (!parsedOut) {
        return { valid: false, message: "Please select a valid Date Out for the gate-out request." };
    }
    if (!parsedIn) {
        return { valid: false, message: "Booking has no valid In Date. Please ask admin to review the booking." };
    }
    if (parsedOut.getTime() <= parsedIn.getTime()) {
        return { valid: false, message: "Date Out must be later than the booking In Date." };
    }
    return { valid: true, inDate: parsedIn, outDate: parsedOut, days: getDateRangeDays(parsedIn, parsedOut) };
};
const rateMatchesBooking = (rate, booking) => {
    const size = String(booking.containerSize || "");
    const type = normalizeBillingRateKey(booking.containerType);
    const loadStatus = normalizeBillingRateKey(booking.containerLoadStatus);
    const rateSize = String(rate.containerSize || "all");
    const rateContainerType = normalizeBillingRateKey(rate.containerType);
    const rateLoad = normalizeBillingRateKey(rate.loadStatus);
    return (rateSize === "all" || rateSize === size)
        && (rateContainerType === "all" || rateContainerType === type)
        && (rateLoad === "all" || rateLoad === loadStatus);
};
const getLatestRateByChargeCode = (rates = []) => {
    const map = new Map();
    for (const rate of rates) {
        const key = String(rate.chargeCode || rate.description || rate._id);
        if (!map.has(key))
            map.set(key, rate);
    }
    return Array.from(map.values());
};
const shouldApplyBillingRate = (rate, booking) => {
    const scope = String(rate.billingScope || "base");
    if (scope === "display_only")
        return false;
    if (scope === "optional_stripping_stuffing") return false;
    return true;
};
const computeBookingBilling = async (booking, { asOf = new Date(), persist = false } = {}) => {
    const effectiveDate = new Date(asOf);
    const activeRates = await BillingRate_js_1.default.find({
        status: "active",
        rateType: normalizeRateType(booking.rateType),
        effectiveDate: { $lte: effectiveDate },
    }).sort({ sortOrder: 1, chargeCode: 1, effectiveDate: -1, createdAt: -1 });
    const matchedRates = getLatestRateByChargeCode(activeRates.filter((rate) => rateMatchesBooking(rate, booking) && shouldApplyBillingRate(rate, booking)));
    const storageDays = getStorageDays(booking, effectiveDate);
    const lineItems = matchedRates.map((rate) => {
        const unit = rate.unit || "per_container";
        const freeDays = Math.max(Number(rate.freeDays) || 0, 0);
        let quantity = 1;
        if (["storage_day", "per_day"].includes(unit)) {
            quantity = Math.max(storageDays - freeDays, 0);
        }
        else if (unit === "per_teu") {
            quantity = getTeuFactor(booking.containerSize);
        }
        const rawAmount = quantity * (Number(rate.rateAmount) || 0);
        const minimumAmount = Math.max(Number(rate.minimumAmount) || 0, 0);
        const amount = quantity > 0 ? Math.max(rawAmount, minimumAmount) : 0;
        return {
            rate: rate._id,
            chargeCode: rate.chargeCode,
            description: String(rate.chargeCode || "").startsWith("LIFT_ON")
                ? "Lift On Charge"
                : String(rate.chargeCode || "").startsWith("LIFT_OFF")
                    ? "Lift Off Charge"
                    : rate.description,
            unit,
            quantity: Math.round(quantity * 100) / 100,
            rateAmount: Number(rate.rateAmount) || 0,
            freeDays,
            minimumAmount,
            category: rate.category || "container_yard_operation",
            billingScope: rate.billingScope || "base",
            rateType: normalizeRateType(rate.rateType),
            amount: Math.round(amount * 100) / 100,
        };
    });
    const additionalLineItems = (booking.additionalBillingCharges || []).map((item, index) => ({
        rate: null,
        chargeCode: `ADDITIONAL_${index + 1}`,
        description: item.description || "Additional Charge",
        unit: "fixed",
        quantity: Number(item.quantity) || 0,
        rateAmount: Number(item.rateAmount) || 0,
        freeDays: 0,
        minimumAmount: 0,
        category: "custom",
        billingScope: "additional",
        rateType: normalizeRateType(booking.rateType),
        amount: Math.round((Number(item.amount) || ((Number(item.quantity) || 0) * (Number(item.rateAmount) || 0))) * 100) / 100,
    }));
    const allLineItems = [...lineItems, ...additionalLineItems];
    const subtotal = Math.round(allLineItems.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
    const total = subtotal;
    const result = {
        lineItems: allLineItems,
        subtotal,
        total,
        days: storageDays,
        computedAt: effectiveDate,
        hasMatchedRates: matchedRates.length > 0,
    };
    if (persist) {
        booking.billingLineItems = allLineItems;
        booking.billingSubtotal = subtotal;
        booking.billingTotal = total;
        booking.billingDays = storageDays;
        booking.billingComputedAt = effectiveDate;
        booking.paymentAmount = total;
    }
    return result;
};
exports.computeBookingBilling = computeBookingBilling;
const refreshComputedBilling = async (booking) => {
    if (!booking)
        return booking;
    const canRefresh = [
        "approved_area_assigned",
        "gate_in_approved",
        "stored_in_assigned_area",
        "gate_out_requested",
        "gate_out_approved",
    ].includes(booking.status)
        && ["unpaid", "payment_rejected"].includes(booking.billingStatus);
    if (!canRefresh)
        return booking;
    const result = await (0, exports.computeBookingBilling)(booking, { persist: true });
    if (result.hasMatchedRates)
        await booking.save();
    return booking;
};
const refreshComputedBillingList = async (bookings = []) => {
    for (const booking of bookings) {
        await refreshComputedBilling(booking);
    }
    return bookings;
};
const getClientDisplayName = (client = {}) => client.companyName || client.name || "Client";
const getClientPortalUrl = () => {
    if (process.env.CLIENT_PUBLIC_URL)
        return process.env.CLIENT_PUBLIC_URL.replace(/\/$/, "");
    const firstOrigin = String(process.env.CLIENT_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean)[0];
    return (firstOrigin || "http://localhost:5173").replace(/\/$/, "");
};
const getBookingTrackingUrl = (bookingNumber = "") => {
    const encoded = encodeURIComponent(String(bookingNumber || "").trim());
    return `${getClientPortalUrl()}/booking-status${encoded ? `?bookingNumber=${encoded}` : ""}`;
};
const addHistory = (booking, { status = booking.status, billingStatus = booking.billingStatus, remarks = "", changedBy = null }) => {
    booking.statusHistory.push({ status, billingStatus, remarks, changedBy, changedAt: new Date() });
};
const populateBooking = (query) => {
    return query
        .populate("client", "name email companyName phoneNumber")
        .populate("assignedArea", "name code")
        .populate("assignedBlock", "name code teuSlots occupiedSlots bayCount rowCount tierCount containerSize");
};
const safeBooking = (booking) => {
    const doc = booking.toObject ? booking.toObject() : booking;
    const client = doc.client || {};
    const area = doc.assignedArea || null;
    const block = doc.assignedBlock || null;
    return {
        id: String(doc._id),
        client: client?._id ? String(client._id) : String(doc.client),
        clientName: getClientDisplayName(client),
        clientEmail: client.email || "",
        clientPhoneNumber: client.phoneNumber || "",
        bookingReference: doc.bookingReference,
        containerNumber: doc.containerNumber,
        containerSize: Number(doc.containerSize),
        containerType: doc.containerType,
        containerLoadStatus: doc.containerLoadStatus,
        serviceType: doc.serviceType || "container_yard",
        rateType: normalizeRateType(doc.rateType),
        shippingLine: doc.shippingLine,
        bookingNumber: doc.bookingNumber || "",
        qrCodeValue: doc.qrCodeValue || "",
        blNumber: doc.blNumber || "",
        vesselVoyage: doc.vesselVoyage || "",
        cargoDescription: doc.cargoDescription || "",
        weight: Number(doc.weight) || 0,
        expectedArrivalDate: doc.expectedArrivalDate,
        inDate: doc.inDate || doc.expectedArrivalDate,
        outDate: doc.outDate,
        clientRemarks: doc.clientRemarks || "",
        documents: doc.documents || [],
        status: doc.status,
        billingStatus: doc.billingStatus,
        rejectionReason: doc.rejectionReason || "",
        assignedArea: area?._id ? String(area._id) : doc.assignedArea ? String(doc.assignedArea) : "",
        assignedAreaName: area?.name || "",
        assignedAreaCode: area?.code || "",
        assignedBlock: block?._id ? String(block._id) : doc.assignedBlock ? String(doc.assignedBlock) : "",
        assignedBlockName: block?.name || "",
        assignedBlockCode: block?.code || "",
        assignedBay: Number(doc.assignedBay) || 1,
        assignedRow: Number(doc.assignedRow) || 1,
        assignedTier: Number(doc.assignedTier) || 1,
        assignedSlotNumber: doc.assignedSlotNumber || "",
        approvedAt: doc.approvedAt,
        gateInApprovedAt: doc.gateInApprovedAt,
        actualContainerNumber: doc.actualContainerNumber || "",
        physicalCondition: doc.physicalCondition || "",
        sealNumber: doc.sealNumber || "",
        truckPlateNumber: doc.truckPlateNumber || "",
        driverName: doc.driverName || "",
        driverLicenseNumber: doc.driverLicenseNumber || "",
        inspectionRemarks: doc.inspectionRemarks || "",
        storedAt: doc.storedAt,
        storageStartDate: doc.storageStartDate,
        billingLineItems: doc.billingLineItems || [],
        additionalBillingCharges: (doc.additionalBillingCharges || []).map((item) => ({
            id: String(item._id),
            description: item.description,
            quantity: Number(item.quantity) || 0,
            rateAmount: Number(item.rateAmount) || 0,
            amount: Number(item.amount) || 0,
            notes: item.notes || "",
            addedAt: item.addedAt,
        })),
        billingSubtotal: Number(doc.billingSubtotal) || 0,
        billingTotal: Number(doc.billingTotal) || 0,
        billingDays: Number(doc.billingDays) || 0,
        billingComputedAt: doc.billingComputedAt,
        paymentAmount: Number(doc.paymentAmount || doc.billingTotal) || 0,
        paymentType: doc.paymentType ? String(doc.paymentType?._id || doc.paymentType) : "",
        paymentTypeSnapshot: doc.paymentTypeSnapshot || {},
        paymentReferenceNumber: doc.paymentReferenceNumber || "",
        paymentDate: doc.paymentDate,
        paymentRemarks: doc.paymentRemarks || "",
        paymentProofs: doc.paymentProofs || [],
        paymentSubmittedAt: doc.paymentSubmittedAt,
        paymentRejectionReason: doc.paymentRejectionReason || "",
        gateOutRequestedAt: doc.gateOutRequestedAt,
        gateOutRequestRemarks: doc.gateOutRequestRemarks || "",
        gateOutApprovedAt: doc.gateOutApprovedAt,
        gateOutRemarks: doc.gateOutRemarks || "",
        releasedAt: doc.releasedAt,
        releaseRemarks: doc.releaseRemarks || "",
        statusHistory: doc.statusHistory || [],
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
};
const notifyEmail = async ({ to, subject, title, booking, message, details = [], qrCodeValue = "", trackingUrl = "" }) => {
    if (!to)
        return;
    try {
        await (0, mailer_js_1.sendEmail)({
            to,
            subject,
            html: (0, emailTemplates_js_1.bookingStatusEmailTemplate)({
                title,
                reference: booking.bookingReference,
                status: booking.status,
                billingStatus: booking.billingStatus,
                message,
                details,
                qrCodeValue,
                trackingUrl,
            }),
            text: `${title}\n${message}\nBooking: ${booking.bookingReference}\nStatus: ${booking.status}\nBilling: ${booking.billingStatus}`,
        });
    }
    catch (error) {
        console.error("[booking-email] failed", { to, subject, error: error.message });
    }
};
const notifyClient = async (booking, title, message, details = [], options = {}) => {
    const populated = booking.client?.email ? booking : await booking.populate("client", "name email companyName");
    await notifyEmail({
        to: populated.client?.email,
        subject: `${title} - ${populated.bookingReference}`,
        title,
        booking: populated,
        message,
        details,
        qrCodeValue: options.qrCodeValue || populated.qrCodeValue || "",
        trackingUrl: options.trackingUrl || "",
    });
};
const notifyAdmin = async (booking, title, message, details = []) => {
    const adminEmail = process.env.SUPER_ADMIN_EMAIL;
    if (!adminEmail)
        return;
    await notifyEmail({
        to: adminEmail,
        subject: `${title} - ${booking.bookingReference}`,
        title,
        booking,
        message,
        details,
    });
};
const uploadBookingPreAdviceDocuments = async ({ files, bookingReference, clientId }) => {
    const uploadedDocs = [];
    for (const fieldName of Object.keys(bookingPreAdviceDocumentLabels)) {
        const list = files?.[fieldName] || [];
        for (const file of list) {
            const result = await (0, localFileStorage_js_1.saveUploadedFile)({
                file,
                clientId,
                category: `booking-${bookingReference}`,
                prefix: fieldName,
            });
            uploadedDocs.push({
                type: fieldName,
                label: bookingPreAdviceDocumentLabels[fieldName],
                fileName: file.originalname,
                url: result.url,
                secureUrl: result.secureUrl,
                publicId: result.publicId,
                resourceType: result.resourceType || "local",
                mimeType: file.mimetype,
                sizeBytes: file.size,
            });
        }
    }
    return uploadedDocs;
};
const uploadBookingPaymentDocuments = async ({ files, bookingReference, clientId }) => {
    const uploadedDocs = [];
    for (const fieldName of Object.keys(bookingPaymentDocumentLabels)) {
        const list = files?.[fieldName] || [];
        for (const file of list) {
            const result = await (0, localFileStorage_js_1.saveUploadedFile)({
                file,
                clientId,
                category: `payment-${bookingReference}`,
                prefix: fieldName,
            });
            uploadedDocs.push({
                type: fieldName,
                label: bookingPaymentDocumentLabels[fieldName],
                fileName: file.originalname,
                url: result.url,
                secureUrl: result.secureUrl,
                publicId: result.publicId,
                resourceType: result.resourceType || "local",
                mimeType: file.mimetype,
                sizeBytes: file.size,
                uploadedAt: new Date(),
            });
        }
    }
    return uploadedDocs;
};
const activeBookingFilterForBlock = (blockId) => ({
    assignedBlock: blockId,
    status: { $in: ACTIVE_BOOKING_STATUSES },
});
const recalculateBlockOccupancy = async (blockId) => {
    if (!blockId)
        return;
    const [block, inventoryContainers, bookingContainers] = await Promise.all([
        YardBlock_js_1.default.findById(blockId).select("containerSize"),
        InventoryContainer_js_1.default.find({ block: blockId, status: { $ne: "released" } }).select("containerSize"),
        Booking_js_1.default.find(activeBookingFilterForBlock(blockId)).select("containerSize"),
    ]);
    if (!block)
        return;
    const occupied = [...inventoryContainers, ...bookingContainers].reduce((total, item) => total + getYardCapacityUsage(item.containerSize, block.containerSize), 0);
    await YardBlock_js_1.default.findByIdAndUpdate(blockId, {
        occupiedSlots: Math.round(occupied * 100) / 100,
    });
};
const validateYardAssignment = async ({ areaId, blockId, bay, row, tier, containerSize, bookingId }) => {
    if (!areaId) {
        const error = new Error("Select yard area before approving the booking.");
        error.statusCode = 400;
        throw error;
    }
    const area = await YardArea_js_1.default.findById(areaId);
    if (!area) {
        const error = new Error("Selected yard area was not found.");
        error.statusCode = 404;
        throw error;
    }
    if (area.status !== "active") {
        const error = new Error("Only active yard areas can be selected.");
        error.statusCode = 400;
        throw error;
    }
    const block = blockId ? await YardBlock_js_1.default.findById(blockId) : await ensureAreaLocationBlock(area);
    if (!block || String(block.area) !== String(area._id)) {
        const error = new Error("Selected yard area location was not found.");
        error.statusCode = 404;
        throw error;
    }
    if (block.status !== "active") {
        const error = new Error("Only active yard areas can be selected.");
        error.statusCode = 400;
        throw error;
    }
    // Yard Area is the user-facing location assignment. The backend uses one internal
    // location record per area so bay, row, and tier availability can still be tracked.
    const nextBay = toPositive(bay, 1);
    const nextRow = toPositive(row, 1);
    const nextTier = toPositive(tier, 1);
    if (nextBay > block.bayCount || nextRow > block.rowCount || nextTier > block.tierCount) {
        const error = new Error(`Location is outside yard area limits. Max bay ${block.bayCount}, row ${block.rowCount}, tier ${block.tierCount}.`);
        error.statusCode = 400;
        throw error;
    }
    const occupiedInventorySlot = await InventoryContainer_js_1.default.findOne({
        block: block._id,
        bay: nextBay,
        row: nextRow,
        tier: nextTier,
        status: { $ne: "released" },
    });
    if (occupiedInventorySlot) {
        const error = new Error("That bay, row, and tier is already occupied in inventory.");
        error.statusCode = 409;
        throw error;
    }
    const reservedBookingSlot = await Booking_js_1.default.findOne({
        _id: { $ne: bookingId },
        assignedBlock: block._id,
        assignedBay: nextBay,
        assignedRow: nextRow,
        assignedTier: nextTier,
        status: { $nin: TERMINAL_BOOKING_STATUSES },
    });
    if (reservedBookingSlot) {
        const error = new Error("That bay, row, and tier is already reserved by another active booking.");
        error.statusCode = 409;
        throw error;
    }
    const [inventoryContainers, bookingContainers] = await Promise.all([
        InventoryContainer_js_1.default.find({ block: block._id, status: { $ne: "released" } }).select("containerSize"),
        Booking_js_1.default.find({ _id: { $ne: bookingId }, assignedBlock: block._id, status: { $nin: TERMINAL_BOOKING_STATUSES } }).select("containerSize"),
    ]);
    const usedCapacity = [...inventoryContainers, ...bookingContainers].reduce((total, item) => total + getYardCapacityUsage(item.containerSize, block.containerSize), 0);
    const containerCapacity = getYardCapacityUsage(containerSize, block.containerSize);
    const capacityUnit = getYardCapacityUnit(block.containerSize);
    if (usedCapacity + containerCapacity > Number(block.teuSlots)) {
        const error = new Error(`Selected yard area does not have enough available ${capacityUnit} capacity.`);
        error.statusCode = 400;
        throw error;
    }
    return {
        area,
        block,
        bay: nextBay,
        row: nextRow,
        tier: nextTier,
        slotNumber: `${block.code}-B${nextBay}-R${nextRow}-T${nextTier}`,
        remainingAfterApproval: Math.max(Number(block.teuSlots) - usedCapacity - containerCapacity, 0),
    };
};
const getSlotKey = (bay, row, tier) => `${bay}-${row}-${tier}`;
const getYardBlockSlots = async (req, res) => {
    const block = await YardBlock_js_1.default.findById(req.params.blockId).populate("area", "name code");
    if (!block) {
        return res.status(404).json({ success: false, message: "Yard block not found." });
    }
    const [inventorySlots, bookingSlots, preAdviceSlots] = await Promise.all([
        InventoryContainer_js_1.default.find({ block: block._id, status: { $ne: "released" } }).select("containerNumber bay row tier status"),
        Booking_js_1.default.find({ assignedBlock: block._id, status: { $nin: TERMINAL_BOOKING_STATUSES } }).select("bookingReference containerNumber assignedBay assignedRow assignedTier status"),
        PreAdvice_js_1.default.find({ plannedBlock: block._id, status: "confirmed" }).select("preAdviceNumber containerNumber plannedBay plannedRow plannedTier status"),
    ]);
    const slots = [
        ...inventorySlots.map((item) => ({
            key: getSlotKey(item.bay, item.row, item.tier),
            bay: Number(item.bay) || 1,
            row: Number(item.row) || 1,
            tier: Number(item.tier) || 1,
            type: "occupied",
            status: item.status,
            containerNumber: item.containerNumber,
            reference: item.containerNumber,
        })),
        ...bookingSlots.map((item) => ({
            key: getSlotKey(item.assignedBay, item.assignedRow, item.assignedTier),
            bay: Number(item.assignedBay) || 1,
            row: Number(item.assignedRow) || 1,
            tier: Number(item.assignedTier) || 1,
            type: item.status === "stored_in_assigned_area" ? "occupied" : "reserved",
            status: item.status,
            containerNumber: item.containerNumber,
            reference: item.bookingReference,
        })),
        ...preAdviceSlots.map((item) => ({
            key: getSlotKey(item.plannedBay, item.plannedRow, item.plannedTier),
            bay: Number(item.plannedBay) || 1,
            row: Number(item.plannedRow) || 1,
            tier: Number(item.plannedTier) || 1,
            type: "reserved",
            status: item.status,
            containerNumber: item.containerNumber,
            reference: item.preAdviceNumber,
        })),
    ];
    return res.json({
        success: true,
        block: {
            id: String(block._id),
            area: block.area?._id ? String(block.area._id) : String(block.area),
            areaName: block.area?.name || "",
            name: block.name,
            code: block.code,
            bayCount: Number(block.bayCount) || 1,
            rowCount: Number(block.rowCount) || 1,
            tierCount: Number(block.tierCount) || 1,
            containerSize: Number(block.containerSize) || 20,
            teuSlots: Number(block.teuSlots) || 0,
            occupiedSlots: Number(block.occupiedSlots) || 0,
            availableSlots: Math.max((Number(block.teuSlots) || 0) - (Number(block.occupiedSlots) || 0), 0),
        },
        slots,
    });
};
exports.getYardBlockSlots = getYardBlockSlots;
const handleValidationError = (error, res) => {
    if (error.statusCode)
        return res.status(error.statusCode).json({ success: false, message: error.message });
    throw error;
};
const createClientBooking = async (req, res) => {
    const { containerNumber, containerSize, containerType, containerLoadStatus, serviceType, rateType, shippingLine, truckPlateNumber, driverName, driverLicenseNumber, blNumber, vesselVoyage, cargoDescription, weight, expectedArrivalDate, inDate, outDate, clientRemarks, } = req.body;
    const requiredFields = [containerNumber, containerSize, containerType, shippingLine, inDate || expectedArrivalDate, truckPlateNumber, driverName];
    if (requiredFields.some((value) => !String(value || "").trim())) {
        return res.status(400).json({ success: false, message: "Please complete all required booking fields." });
    }
    if (![20, 40].includes(Number(containerSize))) {
        return res.status(400).json({ success: false, message: "Container size must be 20ft or 40ft." });
    }
    const dateRange = validateBookingDateRange({ inDate, outDate, expectedArrivalDate });
    if (!dateRange.valid) {
        return res.status(400).json({ success: false, message: dateRange.message });
    }
    const normalizedContainer = normalizeContainerNumber(containerNumber);
    const activeDuplicate = await Booking_js_1.default.findOne({
        containerNumber: normalizedContainer,
        status: { $nin: TERMINAL_BOOKING_STATUSES },
    });
    if (activeDuplicate) {
        return res.status(409).json({ success: false, message: "This container already has an active booking." });
    }
    const inInventory = await InventoryContainer_js_1.default.findOne({
        containerNumber: normalizedContainer,
        status: { $ne: "released" },
    });
    if (inInventory) {
        return res.status(409).json({ success: false, message: "This container is already in active inventory." });
    }
    const bookingReference = await buildSequenceNumber("BK", Booking_js_1.default, "bookingReference");
    if (!req.files?.deliveryOrder?.[0] || !req.files?.bookingConfirmation?.[0]) {
        return res.status(400).json({
            success: false,
            message: "Delivery Order and Booking Confirmation are required for pre-advice verification.",
        });
    }
    const documents = await uploadBookingPreAdviceDocuments({
        files: req.files,
        bookingReference,
        clientId: req.user._id,
    });
    const booking = await Booking_js_1.default.create({
        client: req.user._id,
        bookingReference,
        containerNumber: normalizedContainer,
        containerSize: Number(containerSize),
        containerType,
        containerLoadStatus: containerLoadStatus || "empty",
        serviceType: "container_yard",
        rateType: "local",
        shippingLine,
        truckPlateNumber: truckPlateNumber || "",
        driverName: driverName || "",
        driverLicenseNumber: driverLicenseNumber || "",
        blNumber: blNumber || "",
        vesselVoyage: vesselVoyage || "",
        cargoDescription: cargoDescription || "",
        weight: Number(weight) || 0,
        expectedArrivalDate: dateRange.inDate,
        inDate: dateRange.inDate,
        outDate: null,
        clientRemarks: clientRemarks || "",
        documents,
        status: "pending_admin_approval",
        billingStatus: "unpaid",
        submittedAt: new Date(),
        statusHistory: [
            {
                status: "pending_admin_approval",
                billingStatus: "unpaid",
                remarks: "Booking submitted by client.",
                changedBy: req.user._id,
                changedAt: new Date(),
            },
        ],
    });
    await booking.populate("client", "name email companyName phoneNumber");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:submitted", payload);
    (0, socket_js_1.emitToUser)(req.user._id, "booking:submitted", payload);
    await notifyClient(booking, "Booking submitted for pre-advice review", "Your booking has been received and is now visible in the admin Pre-Advice module for verification.", [
        { label: "Container", value: booking.containerNumber },
        { label: "Container Size", value: `${booking.containerSize}ft` },
        { label: "In Date", value: booking.inDate ? booking.inDate.toLocaleString() : "-" },
    ]);
    await notifyAdmin(booking, "New booking pre-advice", "A client created a booking. It is ready for verification in the Pre-Advice module.", [
        { label: "Client", value: getClientDisplayName(booking.client) },
        { label: "Container", value: booking.containerNumber },
    ]);
    return res.status(201).json({ success: true, message: "Booking submitted as pre-advice. Please wait for admin verification.", booking: payload });
};
exports.createClientBooking = createClientBooking;
const resubmitClientBooking = async (req, res) => {
    const booking = await Booking_js_1.default.findOne({ _id: req.params.id, client: req.user._id });
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (booking.status !== "rejected") {
        return res.status(400).json({ success: false, message: "Only rejected bookings can be resubmitted." });
    }
    const { containerNumber, containerSize, containerType, containerLoadStatus, serviceType, rateType, shippingLine, truckPlateNumber, driverName, driverLicenseNumber, blNumber, vesselVoyage, cargoDescription, weight, expectedArrivalDate, inDate, outDate, clientRemarks, } = req.body;
    const requiredFields = [containerNumber, containerSize, containerType, shippingLine, inDate || expectedArrivalDate, truckPlateNumber, driverName];
    if (requiredFields.some((value) => !String(value || "").trim())) {
        return res.status(400).json({ success: false, message: "Please complete all required booking fields before resubmitting." });
    }
    if (![20, 40].includes(Number(containerSize))) {
        return res.status(400).json({ success: false, message: "Container size must be 20ft or 40ft." });
    }
    const dateRange = validateBookingDateRange({ inDate, outDate, expectedArrivalDate });
    if (!dateRange.valid) {
        return res.status(400).json({ success: false, message: dateRange.message });
    }
    const normalizedContainer = normalizeContainerNumber(containerNumber);
    const activeDuplicate = await Booking_js_1.default.findOne({
        _id: { $ne: booking._id },
        containerNumber: normalizedContainer,
        status: { $nin: TERMINAL_BOOKING_STATUSES },
    });
    if (activeDuplicate) {
        return res.status(409).json({ success: false, message: "This container already has another active booking." });
    }
    const previousBlockId = booking.assignedBlock ? String(booking.assignedBlock) : "";
    booking.containerNumber = normalizedContainer;
    booking.containerSize = Number(containerSize);
    booking.containerType = containerType;
    booking.containerLoadStatus = containerLoadStatus || "empty";
    booking.serviceType = "container_yard";
    booking.rateType = "local";
    booking.shippingLine = shippingLine;
    booking.truckPlateNumber = truckPlateNumber || "";
    booking.driverName = driverName || "";
    booking.driverLicenseNumber = driverLicenseNumber || "";
    booking.blNumber = blNumber || "";
    booking.vesselVoyage = vesselVoyage || "";
    booking.cargoDescription = cargoDescription || "";
    booking.weight = Number(weight) || 0;
    booking.expectedArrivalDate = dateRange.inDate;
    booking.inDate = dateRange.inDate;
    booking.outDate = null;
    booking.clientRemarks = clientRemarks || "";
    booking.status = "pending_admin_approval";
    booking.rejectionReason = "";
    booking.assignedArea = null;
    booking.assignedBlock = null;
    booking.assignedBay = 1;
    booking.assignedRow = 1;
    booking.assignedTier = 1;
    booking.assignedSlotNumber = "";
    booking.assignedAt = null;
    booking.assignedBy = null;
    booking.approvedAt = null;
    booking.approvedBy = null;
    addHistory(booking, { remarks: "Booking resubmitted by client. Yard location must be reassigned by admin.", changedBy: req.user._id });
    await booking.save();
    if (previousBlockId)
        await recalculateBlockOccupancy(previousBlockId);
    await booking.populate("client", "name email companyName phoneNumber");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:resubmitted", payload);
    (0, socket_js_1.emitToUser)(req.user._id, "booking:resubmitted", payload);
    (0, socket_js_1.emitToAdmins)("yard:slot_released", { bookingId: payload.id, previousBlockId });
    await notifyClient(booking, "Booking resubmitted", "Your booking has been resubmitted and is waiting for admin approval again.", [
        { label: "Container", value: booking.containerNumber },
        { label: "Status", value: "Pending Admin Approval" },
    ]);
    await notifyAdmin(booking, "Booking resubmitted", "A client resubmitted a rejected booking. Admin must review and assign a yard location again.", [
        { label: "Client", value: getClientDisplayName(booking.client) },
        { label: "Container", value: booking.containerNumber },
    ]);
    return res.json({ success: true, message: "Booking resubmitted. Please wait for admin approval.", booking: payload });
};
exports.resubmitClientBooking = resubmitClientBooking;
const listClientBookings = async (req, res) => {
    const bookings = await populateBooking(Booking_js_1.default.find({ client: req.user._id })).sort({ createdAt: -1 });
    await refreshComputedBillingList(bookings);
    return res.json({ success: true, bookings: bookings.map(safeBooking) });
};
exports.listClientBookings = listClientBookings;
const getClientBooking = async (req, res) => {
    const booking = await populateBooking(Booking_js_1.default.findOne({ _id: req.params.id, client: req.user._id }));
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    await refreshComputedBilling(booking);
    return res.json({ success: true, booking: safeBooking(booking) });
};
exports.getClientBooking = getClientBooking;
const listAdminBookings = async (req, res) => {
    const { status, billingStatus, search } = req.query;
    const query = {};
    if (status && status !== "all")
        query.status = status;
    if (billingStatus && billingStatus !== "all")
        query.billingStatus = billingStatus;
    if (search) {
        const term = String(search).trim();
        query.$or = [
            { bookingReference: { $regex: term, $options: "i" } },
            { bookingNumber: { $regex: term, $options: "i" } },
            { containerNumber: { $regex: term, $options: "i" } },
            { shippingLine: { $regex: term, $options: "i" } },
        ];
    }
    const bookings = await populateBooking(Booking_js_1.default.find(query)).sort({ createdAt: -1 }).limit(300);
    await refreshComputedBillingList(bookings);
    return res.json({ success: true, bookings: bookings.map(safeBooking) });
};
exports.listAdminBookings = listAdminBookings;
const getAdminBooking = async (req, res) => {
    const booking = await populateBooking(Booking_js_1.default.findById(req.params.id));
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    await refreshComputedBilling(booking);
    return res.json({ success: true, booking: safeBooking(booking) });
};
exports.getAdminBooking = getAdminBooking;
const approveBooking = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (!["pending_admin_approval", "rejected", "approved_area_assigned"].includes(booking.status)) {
        return res.status(400).json({ success: false, message: `Booking cannot be approved from ${booking.status}.` });
    }
    let plan;
    try {
        plan = await validateYardAssignment({
            areaId: req.body.areaId,
            blockId: req.body.blockId,
            bay: req.body.bay,
            row: req.body.row,
            tier: req.body.tier,
            containerSize: booking.containerSize,
            bookingId: booking._id,
        });
    }
    catch (error) {
        return handleValidationError(error, res);
    }
    const previousBlockId = booking.assignedBlock ? String(booking.assignedBlock) : "";
    if (!booking.bookingNumber) {
        booking.bookingNumber = await (0, bookingNumber_js_1.buildBookingNumber)();
    }
    booking.qrCodeValue = `OTLI:BOOKING:${booking.bookingNumber}:${booking.containerNumber}`;
    booking.status = "approved_area_assigned";
    booking.rejectionReason = "";
    booking.approvedAt = new Date();
    booking.approvedBy = req.user._id;
    booking.assignedArea = plan.area._id;
    booking.assignedBlock = plan.block._id;
    booking.assignedBay = plan.bay;
    booking.assignedRow = plan.row;
    booking.assignedTier = plan.tier;
    booking.assignedSlotNumber = plan.slotNumber;
    booking.assignedAt = new Date();
    booking.assignedBy = req.user._id;
    booking.storageStartDate = booking.storageStartDate || booking.inDate || booking.expectedArrivalDate || booking.approvedAt;
    const billingResult = await (0, exports.computeBookingBilling)(booking, { persist: true });
    addHistory(booking, {
        remarks: billingResult.hasMatchedRates
            ? `Booking approved, yard area assigned, and initial Lift On, Lift Off, and storage billing added at PHP ${billingResult.total.toLocaleString()}. Storage charges refresh daily.`
            : "Booking approved and yard area assigned. Billing will appear when matching active rates are configured.",
        changedBy: req.user._id,
    });
    await booking.save();
    await recalculateBlockOccupancy(plan.block._id);
    if (previousBlockId && previousBlockId !== String(plan.block._id))
        await recalculateBlockOccupancy(previousBlockId);
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code");
    await booking.populate("assignedBlock", "name code teuSlots occupiedSlots bayCount rowCount tierCount containerSize");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:approved", payload);
    (0, socket_js_1.emitToAdmins)("yard:slot_reserved", payload);
    (0, socket_js_1.emitToAdmins)("inventory:updated", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:approved", payload);
    await notifyClient(booking, "Booking approved and QR generated", "Your booking was approved. A booking number and QR value have been generated. Use the tracking page to view the latest status.", [
        { label: "Booking Number", value: booking.bookingNumber },
        { label: "Container", value: booking.containerNumber },
        { label: "Driver", value: booking.driverName },
        { label: "Truck Plate", value: booking.truckPlateNumber },
        { label: "Assigned Area", value: payload.assignedAreaName },
        { label: "Slot", value: payload.assignedSlotNumber },
        { label: "Tracking Page", value: getBookingTrackingUrl(booking.bookingNumber) },
    ], {
        qrCodeValue: booking.qrCodeValue,
        trackingUrl: getBookingTrackingUrl(booking.bookingNumber),
    });
    return res.json({ success: true, message: "Booking approved, yard area assigned, and billing initialized.", booking: payload });
};
exports.approveBooking = approveBooking;
const rejectBooking = async (req, res) => {
    const { reason } = req.body;
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (!String(reason || "").trim()) {
        return res.status(400).json({ success: false, message: "Rejection reason is required." });
    }
    if (!["pending_admin_approval", "approved_area_assigned", "rejected"].includes(booking.status)) {
        return res.status(400).json({ success: false, message: `Booking cannot be rejected from ${booking.status}.` });
    }
    const previousBlockId = booking.assignedBlock ? String(booking.assignedBlock) : "";
    booking.status = "rejected";
    booking.rejectionReason = reason;
    booking.assignedArea = null;
    booking.assignedBlock = null;
    booking.assignedBay = 1;
    booking.assignedRow = 1;
    booking.assignedTier = 1;
    booking.assignedSlotNumber = "";
    booking.assignedAt = null;
    booking.assignedBy = null;
    booking.approvedAt = null;
    booking.approvedBy = null;
    addHistory(booking, { remarks: `Booking rejected: ${reason}. Yard slot released.`, changedBy: req.user._id });
    await booking.save();
    if (previousBlockId)
        await recalculateBlockOccupancy(previousBlockId);
    await booking.populate("client", "name email companyName phoneNumber");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:rejected", payload);
    (0, socket_js_1.emitToAdmins)("yard:slot_released", { ...payload, previousBlockId });
    (0, socket_js_1.emitToAdmins)("inventory:updated", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:rejected", payload);
    await notifyClient(booking, "Booking rejected", "Your booking was rejected. Please review the reason and contact OTLI if you need assistance.", [
        { label: "Reason", value: reason },
    ]);
    return res.json({ success: true, message: "Booking rejected.", booking: payload });
};
exports.rejectBooking = rejectBooking;
const approveBookingGateIn = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (booking.status !== "approved_area_assigned") {
        return res.status(400).json({ success: false, message: "Only approved bookings with assigned area can be approved for Gate-In." });
    }
    if (!booking.assignedArea || !booking.assignedBlock) {
        return res.status(400).json({ success: false, message: "Booking has no assigned yard area." });
    }
    const actualContainerNumber = normalizeContainerNumber(req.body.actualContainerNumber || booking.containerNumber);
    if (actualContainerNumber !== booking.containerNumber) {
        return res.status(400).json({ success: false, message: "Actual container number must match the approved booking." });
    }
    if (!booking.truckPlateNumber || !booking.driverName) {
        return res.status(400).json({ success: false, message: "Truck plate number and driver name must be added in the booking before Gate-In." });
    }
    booking.status = "gate_in_approved";
    booking.gateInApprovedAt = new Date();
    booking.gateInApprovedBy = req.user._id;
    booking.actualContainerNumber = actualContainerNumber;
    booking.physicalCondition = req.body.physicalCondition || "Good";
    booking.sealNumber = req.body.sealNumber || "";
    booking.truckPlateNumber = booking.truckPlateNumber || req.body.truckPlateNumber || "";
    booking.driverName = booking.driverName || req.body.driverName || "";
    booking.driverLicenseNumber = booking.driverLicenseNumber || req.body.driverLicenseNumber || "";
    booking.inspectionRemarks = req.body.inspectionRemarks || "";
    addHistory(booking, { remarks: "Gate-In approved after inspection.", changedBy: req.user._id });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:gate_in_approved", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:gate_in_approved", payload);
    await notifyClient(booking, "Gate-In approved", "Your container has entered the yard gate and passed inspection.", [
        { label: "Container", value: booking.containerNumber },
        { label: "Truck Plate", value: booking.truckPlateNumber },
    ]);
    return res.json({ success: true, message: "Gate-In approved.", booking: payload });
};
exports.approveBookingGateIn = approveBookingGateIn;
const markBookingStored = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (!["gate_in_approved", "stored_in_assigned_area"].includes(booking.status)) {
        return res.status(400).json({ success: false, message: "Only gate-in approved bookings can be marked as stored." });
    }
    const wasAlreadyStored = booking.status === "stored_in_assigned_area";
    const storedAt = booking.storedAt || new Date();
    booking.status = "stored_in_assigned_area";
    booking.storedAt = storedAt;
    booking.storedBy = booking.storedBy || req.user._id;
    booking.storageStartDate = booking.storageStartDate || booking.inDate || storedAt;
    const billingResult = await (0, exports.computeBookingBilling)(booking, { persist: true });
    addHistory(booking, {
        remarks: billingResult?.hasMatchedRates
            ? `${wasAlreadyStored ? "Stored container billing refreshed" : "Container stored in assigned yard location"}. Billing auto-computed at PHP ${billingResult.total.toLocaleString()} using ${billingResult.days} storage day${billingResult.days === 1 ? "" : "s"}.`
            : "Container stored in the assigned yard location. Configure matching active Lift On, Lift Off, and Storage rates to generate billing line items.",
        changedBy: req.user._id,
    });
    await booking.save();
    await recalculateBlockOccupancy(booking.assignedBlock);
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:stored", payload);
    (0, socket_js_1.emitToAdmins)("storage:updated", payload);
    (0, socket_js_1.emitToAdmins)("inventory:updated", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:stored", payload);
    await notifyClient(booking, "Container stored in assigned area", "Your container has been successfully placed in the assigned yard area.", [
        { label: "Assigned Area", value: payload.assignedAreaName },
        { label: "Slot", value: payload.assignedSlotNumber },
    ]);
    return res.json({ success: true, message: wasAlreadyStored ? "Stored container billing refreshed." : "Container marked as stored and billing refreshed.", booking: payload });
};
exports.markBookingStored = markBookingStored;
const updateBookingBillingOperation = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (!["unpaid", "payment_rejected"].includes(booking.billingStatus)) {
        return res.status(400).json({ success: false, message: "Billing operation can no longer be changed after payment is submitted or approved." });
    }
    const serviceType = normalizeBookingServiceType(req.body.serviceType);
    const rateType = normalizeRateType(req.body.rateType ?? booking.rateType);
    booking.serviceType = serviceType;
    booking.rateType = rateType;
    const shouldRecompute = ["approved_area_assigned", "gate_in_approved", "stored_in_assigned_area", "gate_out_requested", "gate_out_approved"].includes(booking.status);
    const billingResult = shouldRecompute ? await (0, exports.computeBookingBilling)(booking, { persist: true }) : null;
    const serviceLabel = serviceType === "stripping_stuffing_mano" ? "Stripping / Stuffing with Mano" : "Container Yard Operation";
    const rateTypeLabel = rateType === "international" ? "International" : "Local";
    addHistory(booking, {
        remarks: billingResult
            ? `Billing operation set to ${serviceLabel} using ${rateTypeLabel} rates. Billing recomputed at PHP ${billingResult.total.toLocaleString()} using ${billingResult.days} storage day${billingResult.days === 1 ? "" : "s"}.`
            : `Billing operation set to ${serviceLabel} using ${rateTypeLabel} rates. Billing will compute after the container is marked stored.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:billing_operation_updated", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:billing_operation_updated", payload);
    return res.json({ success: true, message: billingResult ? "Billing operation updated and bill recomputed." : "Billing operation updated.", booking: payload });
};
exports.updateBookingBillingOperation = updateBookingBillingOperation;
const addBookingAdditionalCharge = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (!["unpaid", "payment_rejected"].includes(booking.billingStatus)) {
        return res.status(400).json({ success: false, message: "Additional charges can only be changed before payment is submitted or after a rejected payment." });
    }
    const description = String(req.body.description || "").trim();
    const quantity = Math.max(Number(req.body.quantity) || 1, 0);
    const rateAmount = Math.max(Number(req.body.rateAmount) || 0, 0);
    if (!description)
        return res.status(400).json({ success: false, message: "Additional charge description is required." });
    if (rateAmount <= 0)
        return res.status(400).json({ success: false, message: "Additional charge rate must be greater than zero." });
    booking.additionalBillingCharges.push({
        description,
        quantity,
        rateAmount,
        amount: Math.round(quantity * rateAmount * 100) / 100,
        notes: String(req.body.notes || "").trim(),
        addedBy: req.user._id,
        addedAt: new Date(),
    });
    const canCompute = ["approved_area_assigned", "gate_in_approved", "stored_in_assigned_area", "gate_out_requested", "gate_out_approved"].includes(booking.status);
    const billingResult = canCompute ? await (0, exports.computeBookingBilling)(booking, { persist: true }) : null;
    addHistory(booking, {
        remarks: billingResult
            ? `Additional billing charge added: ${description}. Bill recomputed at PHP ${billingResult.total.toLocaleString()}.`
            : `Additional billing charge added: ${description}. It will be included when final billing is computed.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:additional_charge_added", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:additional_charge_added", payload);
    return res.status(201).json({ success: true, message: "Additional billing charge added.", booking: payload });
};
exports.addBookingAdditionalCharge = addBookingAdditionalCharge;
const deleteBookingAdditionalCharge = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (!["unpaid", "payment_rejected"].includes(booking.billingStatus)) {
        return res.status(400).json({ success: false, message: "Additional charges can only be changed before payment is submitted or after a rejected payment." });
    }
    const charge = booking.additionalBillingCharges.id(req.params.chargeId);
    if (!charge)
        return res.status(404).json({ success: false, message: "Additional charge not found." });
    const description = charge.description;
    charge.deleteOne();
    const billingResult = ["approved_area_assigned", "gate_in_approved", "stored_in_assigned_area", "gate_out_requested", "gate_out_approved"].includes(booking.status) ? await (0, exports.computeBookingBilling)(booking, { persist: true }) : null;
    addHistory(booking, {
        remarks: billingResult
            ? `Additional billing charge removed: ${description}. Bill recomputed at PHP ${billingResult.total.toLocaleString()}.`
            : `Additional billing charge removed: ${description}.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:additional_charge_deleted", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:additional_charge_deleted", payload);
    return res.json({ success: true, message: "Additional billing charge removed.", booking: payload });
};
exports.deleteBookingAdditionalCharge = deleteBookingAdditionalCharge;
const submitBookingPayment = async (req, res) => {
    const booking = await Booking_js_1.default.findOne({ _id: req.params.id, client: req.user._id });
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (!["gate_out_requested", "gate_out_approved"].includes(booking.status) || !booking.outDate) {
        return res.status(400).json({ success: false, message: "Payment can only be submitted after the gate-out request includes Date Out and final billing is computed." });
    }
    const billingResult = await (0, exports.computeBookingBilling)(booking, { persist: true });
    if (!billingResult.hasMatchedRates) {
        return res.status(400).json({ success: false, message: "No active billing rate matched this booking. Please ask admin to complete Rate Setup first." });
    }
    if (billingResult.total <= 0) {
        return res.status(400).json({ success: false, message: "Computed billing amount is zero. Please ask admin to review the rate setup." });
    }
    const paymentType = await PaymentType_js_1.default.findOne({ _id: req.body.paymentTypeId, status: "active" });
    if (!paymentType) {
        return res.status(400).json({ success: false, message: "Please select an available payment type." });
    }
    const paymentProofs = await uploadBookingPaymentDocuments({
        files: req.files,
        bookingReference: booking.bookingReference,
        clientId: req.user._id,
    });
    if (paymentProofs.length === 0) {
        return res.status(400).json({ success: false, message: "Please upload at least one payment proof." });
    }
    booking.paymentAmount = billingResult.total;
    booking.paymentType = paymentType._id;
    booking.paymentTypeSnapshot = {
        type: paymentType.type,
        name: paymentType.name,
        bankName: paymentType.bankName || "",
        accountNumber: paymentType.accountNumber,
        accountName: paymentType.accountName,
        qrUrl: paymentType.qrSecureUrl || paymentType.qrUrl || "",
    };
    booking.paymentReferenceNumber = String(booking.paymentReferenceNumber || await buildPaymentReferenceNumber()).trim();
    booking.paymentDate = req.body.paymentDate || new Date();
    booking.paymentRemarks = req.body.paymentRemarks || "";
    booking.paymentProofs = [...booking.paymentProofs, ...paymentProofs];
    booking.paymentSubmittedAt = new Date();
    booking.paymentRejectionReason = "";
    booking.billingStatus = "payment_under_review";
    addHistory(booking, {
        billingStatus: "payment_under_review",
        remarks: `Payment proof submitted by client. Billing was auto-computed from rate setup at PHP ${billingResult.total.toLocaleString()}.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:payment_submitted", payload);
    (0, socket_js_1.emitToUser)(req.user._id, "booking:payment_submitted", payload);
    await notifyClient(booking, "Payment submitted", "Your payment proof was submitted and is now under admin review.", [
        { label: "Reference Number", value: booking.paymentReferenceNumber },
        { label: "Amount", value: `PHP ${booking.paymentAmount.toLocaleString()}` },
    ]);
    await notifyAdmin(booking, "Payment submitted for review", "A client uploaded payment proof for review.", [
        { label: "Client", value: getClientDisplayName(booking.client) },
        { label: "Reference Number", value: booking.paymentReferenceNumber },
    ]);
    return res.json({ success: true, message: "Payment submitted for admin review.", booking: payload });
};
exports.submitBookingPayment = submitBookingPayment;
const approveBookingPayment = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (!["payment_submitted", "payment_under_review", "payment_rejected"].includes(booking.billingStatus)) {
        return res.status(400).json({ success: false, message: "Only submitted payments can be approved." });
    }
    booking.billingStatus = "paid_approved";
    booking.paymentReviewedAt = new Date();
    booking.paymentReviewedBy = req.user._id;
    booking.paymentRejectionReason = "";
    addHistory(booking, { billingStatus: "paid_approved", remarks: req.body.remarks || "Payment approved by admin.", changedBy: req.user._id });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:payment_approved", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:payment_approved", payload);
    await notifyClient(booking, "Payment approved", "Your payment has been approved. Admin can now approve the gate-out release.", [
        { label: "Payment Reference", value: booking.paymentReferenceNumber },
    ]);
    return res.json({ success: true, message: "Payment approved.", booking: payload });
};
exports.approveBookingPayment = approveBookingPayment;
const rejectBookingPayment = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    const reason = req.body.reason || "Payment proof was rejected by admin.";
    booking.billingStatus = "payment_rejected";
    booking.paymentReviewedAt = new Date();
    booking.paymentReviewedBy = req.user._id;
    booking.paymentRejectionReason = reason;
    addHistory(booking, { billingStatus: "payment_rejected", remarks: `Payment rejected: ${reason}`, changedBy: req.user._id });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:payment_rejected", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:payment_rejected", payload);
    await notifyClient(booking, "Payment rejected", "Your payment proof was rejected. Please upload corrected payment details.", [
        { label: "Reason", value: reason },
    ]);
    return res.json({ success: true, message: "Payment rejected.", booking: payload });
};
exports.rejectBookingPayment = rejectBookingPayment;
const requestBookingGateOut = async (req, res) => {
    const booking = await Booking_js_1.default.findOne({ _id: req.params.id, client: req.user._id });
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (booking.status !== "stored_in_assigned_area") {
        return res.status(400).json({ success: false, message: "Gate-out can only be requested after the container is stored in the assigned area." });
    }
    if (booking.billingStatus !== "unpaid") {
        return res.status(403).json({ success: false, message: "Date Out must be submitted before payment is uploaded or approved." });
    }
    const gateOutDate = validateGateOutDate(booking, req.body.outDate || req.body.gateOutDate);
    if (!gateOutDate.valid) {
        return res.status(400).json({ success: false, message: gateOutDate.message });
    }
    booking.outDate = gateOutDate.outDate;
    const billingResult = await (0, exports.computeBookingBilling)(booking, { asOf: gateOutDate.outDate, persist: true });
    if (!billingResult.hasMatchedRates) {
        return res.status(400).json({ success: false, message: "No active billing rate matched this booking. Please ask admin to complete Rate Setup first." });
    }
    if (billingResult.total <= 0) {
        return res.status(400).json({ success: false, message: "Computed billing amount is zero. Please ask admin to review the rate setup." });
    }
    booking.status = "gate_out_requested";
    booking.gateOutRequestedAt = new Date();
    booking.gateOutRequestRemarks = req.body.remarks || "";
    addHistory(booking, {
        remarks: `Gate-out requested by client for ${gateOutDate.outDate.toLocaleString()}. Final billing auto-computed at PHP ${billingResult.total.toLocaleString()} using ${billingResult.days} storage day${billingResult.days === 1 ? "" : "s"}.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:gate_out_requested", payload);
    (0, socket_js_1.emitToUser)(req.user._id, "booking:gate_out_requested", payload);
    await notifyClient(booking, "Gate-out date submitted", "Your Date Out was submitted and the final bill is now ready for payment.", [
        { label: "Container", value: booking.containerNumber },
        { label: "Date Out", value: booking.outDate ? booking.outDate.toLocaleString() : "-" },
        { label: "Final Bill", value: `PHP ${booking.billingTotal.toLocaleString()}` },
    ]);
    await notifyAdmin(booking, "Gate-out requested", "A client has submitted Date Out and requested gate-out release.", [
        { label: "Client", value: getClientDisplayName(booking.client) },
        { label: "Container", value: booking.containerNumber },
        { label: "Date Out", value: booking.outDate ? booking.outDate.toLocaleString() : "-" },
    ]);
    return res.json({ success: true, message: "Gate-out request submitted. Final billing is ready for payment.", booking: payload });
};
exports.requestBookingGateOut = requestBookingGateOut;
const approveBookingGateOut = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (booking.status !== "gate_out_requested") {
        return res.status(400).json({ success: false, message: "Only requested gate-out bookings can be approved." });
    }
    if (booking.billingStatus !== "paid_approved") {
        return res.status(403).json({ success: false, message: "Payment must be paid / approved before gate-out approval." });
    }
    booking.status = "gate_out_approved";
    booking.gateOutApprovedAt = new Date();
    booking.gateOutApprovedBy = req.user._id;
    booking.gateOutRemarks = req.body.remarks || "";
    addHistory(booking, { remarks: "Gate-out approved by admin.", changedBy: req.user._id });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:gate_out_approved", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:gate_out_approved", payload);
    await notifyClient(booking, "Gate-out approved", "Your container is approved for release from the yard.", [
        { label: "Container", value: booking.containerNumber },
        { label: "Assigned Slot", value: booking.assignedSlotNumber },
    ]);
    return res.json({ success: true, message: "Gate-out approved.", booking: payload });
};
exports.approveBookingGateOut = approveBookingGateOut;
const completeBookingGateOut = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (booking.status !== "gate_out_approved") {
        return res.status(400).json({ success: false, message: "Only approved gate-out bookings can be completed." });
    }
    const actualContainerNumber = normalizeContainerNumber(req.body.actualContainerNumber || booking.containerNumber);
    if (actualContainerNumber !== booking.containerNumber) {
        return res.status(400).json({ success: false, message: "Final container number must match the booking." });
    }
    const previousBlockId = booking.assignedBlock ? String(booking.assignedBlock) : "";
    booking.status = "completed_gate_out_done";
    booking.releasedAt = new Date();
    booking.releasedBy = req.user._id;
    booking.releaseRemarks = req.body.remarks || "";
    addHistory(booking, { remarks: "Container released and booking completed.", changedBy: req.user._id });
    await booking.save();
    if (previousBlockId)
        await recalculateBlockOccupancy(previousBlockId);
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:completed", payload);
    (0, socket_js_1.emitToAdmins)("yard:slot_released", { ...payload, previousBlockId });
    (0, socket_js_1.emitToAdmins)("storage:updated", payload);
    (0, socket_js_1.emitToAdmins)("inventory:updated", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:completed", payload);
    await notifyClient(booking, "Container released", "Your container has successfully left the yard. The booking is now completed.", [
        { label: "Container", value: booking.containerNumber },
    ]);
    return res.json({ success: true, message: "Gate-out completed and booking marked as done.", booking: payload });
};
exports.completeBookingGateOut = completeBookingGateOut;
const relocateBooking = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (!["approved_area_assigned", "gate_in_approved", "stored_in_assigned_area"].includes(booking.status)) {
        return res.status(400).json({
            success: false,
            message: "Only approved, gate-in approved, or stored bookings can be relocated.",
        });
    }
    let plan;
    try {
        plan = await validateYardAssignment({
            areaId: req.body.areaId,
            blockId: req.body.blockId,
            bay: req.body.bay,
            row: req.body.row,
            tier: req.body.tier,
            containerSize: booking.containerSize,
            bookingId: booking._id,
        });
    }
    catch (error) {
        return handleValidationError(error, res);
    }
    const previousBlockId = booking.assignedBlock ? String(booking.assignedBlock) : "";
    const previousSlot = booking.assignedSlotNumber || "";
    booking.assignedArea = plan.area._id;
    booking.assignedBlock = plan.block._id;
    booking.assignedBay = plan.bay;
    booking.assignedRow = plan.row;
    booking.assignedTier = plan.tier;
    booking.assignedSlotNumber = plan.slotNumber;
    booking.assignedAt = new Date();
    booking.assignedBy = req.user._id;
    if (booking.status === "stored_in_assigned_area") {
        booking.storageStartDate = booking.storageStartDate || new Date();
    }
    addHistory(booking, {
        remarks: `Yard location updated from ${previousSlot || "unassigned"} to ${plan.slotNumber}.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await recalculateBlockOccupancy(plan.block._id);
    if (previousBlockId && previousBlockId !== String(plan.block._id))
        await recalculateBlockOccupancy(previousBlockId);
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code");
    await booking.populate("assignedBlock", "name code teuSlots occupiedSlots bayCount rowCount tierCount containerSize");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:relocated", payload);
    (0, socket_js_1.emitToAdmins)("inventory:updated", payload);
    (0, socket_js_1.emitToAdmins)("storage:updated", payload);
    (0, socket_js_1.emitToAdmins)("yard:slot_relocated", { ...payload, previousBlockId, previousSlot });
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:relocated", payload);
    await notifyClient(booking, "Container yard location updated", "Your container yard location has been updated by the admin.", [
        { label: "Assigned Area", value: payload.assignedAreaName },
        { label: "Slot", value: payload.assignedSlotNumber },
    ]);
    return res.json({ success: true, message: "Yard location updated successfully.", booking: payload });
};
exports.relocateBooking = relocateBooking;
const getPublicBookingByNumber = async (req, res) => {
    const rawNumber = String(req.params.bookingNumber || req.query.bookingNumber || "").trim();
    const lookup = rawNumber.toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (!lookup) {
        return res.status(400).json({ success: false, message: "Enter a booking number." });
    }
    const booking = await populateBooking(Booking_js_1.default.findOne({
        $or: [
            { bookingNumber: lookup },
            { bookingReference: lookup },
        ],
    }));
    if (!booking) {
        return res.status(404).json({ success: false, message: "Booking number was not found." });
    }
    return res.json({
        success: true,
        booking: safeBooking(booking),
        trackingUrl: getBookingTrackingUrl(booking.bookingNumber || booking.bookingReference),
    });
};
exports.getPublicBookingByNumber = getPublicBookingByNumber;
const getBookingSummary = async (req, res) => {
    const [total, pending, approved, gateIn, stored, gateOutRequested, completed, unpaid, paymentReview, paid] = await Promise.all([
        Booking_js_1.default.countDocuments(),
        Booking_js_1.default.countDocuments({ status: "pending_admin_approval" }),
        Booking_js_1.default.countDocuments({ status: "approved_area_assigned" }),
        Booking_js_1.default.countDocuments({ status: "gate_in_approved" }),
        Booking_js_1.default.countDocuments({ status: "stored_in_assigned_area" }),
        Booking_js_1.default.countDocuments({ status: "gate_out_requested" }),
        Booking_js_1.default.countDocuments({ status: "completed_gate_out_done" }),
        Booking_js_1.default.countDocuments({ billingStatus: "unpaid" }),
        Booking_js_1.default.countDocuments({ billingStatus: "payment_under_review" }),
        Booking_js_1.default.countDocuments({ billingStatus: "paid_approved" }),
    ]);
    return res.json({
        success: true,
        summary: { total, pending, approved, gateIn, stored, gateOutRequested, completed, unpaid, paymentReview, paid },
    });
};
exports.getBookingSummary = getBookingSummary;
