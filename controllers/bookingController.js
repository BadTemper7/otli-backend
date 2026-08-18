"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBookingSummary = exports.getPublicBookingByNumber = exports.relocateBooking = exports.completeBookingGateOut = exports.recomputeGateOutBilling = exports.previewGateOutBilling = exports.rejectGateOutReversal = exports.approveGateOutReversal = exports.requestGateOutReversal = exports.cancelBooking = exports.rejectBookingGateOut = exports.approveBookingGateOut = exports.requestBookingGateOut = exports.rejectBookingPayment = exports.approveBookingPayment = exports.recordAdminCashPayment = exports.submitBookingPayment = exports.deleteBookingAdditionalCharge = exports.addBookingCongestionSurcharge = exports.getBookingCongestionSurchargeOption = exports.addBookingAdditionalCharge = exports.updateBookingRateClassification = exports.updateBookingBillingOperation = exports.markBookingStored = exports.rejectBookingGateIn = exports.approveBookingGateIn = exports.rejectBooking = exports.approveBooking = exports.deleteBooking = exports.getAdminBookingCalendar = exports.getAdminBooking = exports.listAdminBookings = exports.getClientBooking = exports.listClientBookings = exports.resubmitClientBooking = exports.createClientBooking = exports.getYardBlockSlots = exports.computeBookingBilling = void 0;
const Booking_js_1 = __importDefault(require("../models/Booking.js"));
const PreAdvice_js_1 = __importDefault(require("../models/PreAdvice.js"));
const InventoryContainer_js_1 = __importDefault(require("../models/InventoryContainer.js"));
const YardArea_js_1 = __importDefault(require("../models/YardArea.js"));
const YardBlock_js_1 = __importDefault(require("../models/YardBlock.js"));
const BillingRate_js_1 = __importDefault(require("../models/BillingRate.js"));
const PaymentType_js_1 = __importDefault(require("../models/PaymentType.js"));
const ReleaseReport_js_1 = __importDefault(require("../models/ReleaseReport.js"));
const localFileStorage_js_1 = require("../utils/localFileStorage.js");
const mailer_js_1 = require("../config/mailer.js");
const emailTemplates_js_1 = require("../utils/emailTemplates.js");
const socket_js_1 = require("../socket/socket.js");
const bookingNumber_js_1 = require("../utils/bookingNumber.js");
const billingDays_js_1 = require("../utils/billingDays.js");
const notificationService_js_1 = require("../utils/notificationService.js");
const ACTIVE_BOOKING_STATUSES = [
    "approved_area_assigned",
    "gate_in_approved",
    "stored_in_assigned_area",
    "gate_out_requested",
    "gate_out_approved",
    "gate_out_reversal_requested",
];
const TERMINAL_BOOKING_STATUSES = ["rejected", "cancelled", "completed_gate_out_done"];
const normalizeContainerNumber = (value = "") => String(value).toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
const buildGatePassNumber = (prefix, bookingReference, bookingId = "") => {
    const reference = String(bookingReference || bookingId || Date.now())
        .toUpperCase()
        .replace(/^BK-?/, "")
        .replace(/[^A-Z0-9-]/g, "")
        .replace(/^-+|-+$/g, "");
    return `${prefix}-${reference || Date.now()}`;
};
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
const normalizeRateType = (value) => String(value || "").toLowerCase() === "international" ? "international" : "local";
const CONDITION_OPTIONS = ["GOOD", "DENTED", "RUST", "HOLE", "DOOR DAMAGE", "OTHER"];
const normalizeConditionSelections = (values = []) => {
    const next = Array.isArray(values) ? values : values ? [values] : [];
    return Array.from(new Set(next.map((value) => String(value || "").trim().toUpperCase()).filter((value) => CONDITION_OPTIONS.includes(value))));
};
const buildConditionSummary = (conditions = [], other = "") => {
    const normalized = normalizeConditionSelections(conditions);
    const labels = normalized.filter((value) => value !== "OTHER");
    const otherText = String(other || "").trim();
    if (normalized.includes("OTHER") && otherText) {
        labels.push(`OTHER: ${otherText}`);
    }
    else if (normalized.includes("OTHER")) {
        labels.push("OTHER");
    }
    return labels.join(", ") || "GOOD";
};
const normalizeYesNo = (value = "") => {
    const normalized = String(value || "").trim().toLowerCase();
    return ["yes", "no"].includes(normalized) ? normalized : "";
};
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
const getDateRangeDays = (startValue, endValue) => (0, billingDays_js_1.getCalendarBillingDays)(startValue, endValue);
const getGateOutGracePeriodMinutes = (booking = {}) => {
    const configured = Number(booking.gateOutGracePeriodMinutes ?? process.env.GATE_OUT_GRACE_PERIOD_MINUTES ?? 120);
    return Number.isFinite(configured) ? Math.max(configured, 0) : 120;
};
const getGateOutScheduleInfo = (booking = {}, asOf = new Date()) => {
    const serverTime = parseBookingDate(asOf) || new Date();
    const scheduledAt = parseBookingDate(booking.outDate);
    const gracePeriodMinutes = getGateOutGracePeriodMinutes(booking);
    const overstayStartedAt = scheduledAt
        ? new Date(scheduledAt.getTime() + gracePeriodMinutes * 60 * 1000)
        : null;
    if (booking.releasedAt || booking.status === "completed_gate_out_done") {
        return {
            status: "released",
            isOverstaying: false,
            scheduledAt,
            gracePeriodMinutes,
            overstayStartedAt,
            overstayDurationMinutes: 0,
            serverTime,
        };
    }
    if (!scheduledAt) {
        return {
            status: "not_scheduled",
            isOverstaying: false,
            scheduledAt: null,
            gracePeriodMinutes,
            overstayStartedAt: null,
            overstayDurationMinutes: 0,
            serverTime,
        };
    }
    const approvedForRelease = ["gate_out_approved", "gate_out_reversal_requested"].includes(String(booking.status || ""));
    const isOverstaying = approvedForRelease && overstayStartedAt && serverTime.getTime() > overstayStartedAt.getTime();
    const status = isOverstaying
        ? "overstaying"
        : approvedForRelease
            ? "awaiting_release"
            : "scheduled";
    return {
        status,
        isOverstaying,
        scheduledAt,
        gracePeriodMinutes,
        overstayStartedAt,
        overstayDurationMinutes: isOverstaying
            ? Math.max(Math.floor((serverTime.getTime() - overstayStartedAt.getTime()) / 60000), 0)
            : 0,
        serverTime,
    };
};
const getStorageDays = (booking, asOf = new Date(), { useAsOfAsBillingEnd = false } = {}) => {
    const effectiveAsOf = parseBookingDate(asOf) || new Date();
    const { inDate, outDate } = resolveBookingDateRange(booking);
    const start = inDate || booking.storageStartDate || booking.storedAt || booking.gateInApprovedAt || booking.createdAt || effectiveAsOf;
    const releasedAt = parseBookingDate(booking.releasedAt);
    const approvedAndInsideYard = ["gate_out_approved", "gate_out_reversal_requested"].includes(String(booking.status || "")) && !releasedAt;
    let billingEnd = releasedAt || outDate || effectiveAsOf;
    if (!releasedAt && useAsOfAsBillingEnd) {
        billingEnd = effectiveAsOf;
    }
    else if (approvedAndInsideYard && (!outDate || effectiveAsOf.getTime() > outDate.getTime())) {
        billingEnd = effectiveAsOf;
    }
    return (0, billingDays_js_1.getCalendarBillingDays)(start, billingEnd) || 1;
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
const MAX_CONTAINERS_PER_HOUR = 4;
const getBookingHourWindow = (value) => {
    const start = parseBookingDate(value);
    if (!start) return null;
    start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return { start, end };
};
const ensureBookingHourCapacity = async (value, excludeBookingId = null) => {
    const window = getBookingHourWindow(value);
    if (!window) return;
    const filter = {
        inDate: { $gte: window.start, $lt: window.end },
        status: { $nin: TERMINAL_BOOKING_STATUSES },
    };
    if (excludeBookingId) filter._id = { $ne: excludeBookingId };
    const bookedCount = await Booking_js_1.default.countDocuments(filter);
    if (bookedCount >= MAX_CONTAINERS_PER_HOUR) {
        const displayTime = window.start.toLocaleString("en-PH", {
            month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
        });
        const error = new Error(`The ${displayTime} schedule is full. Operations can accept only ${MAX_CONTAINERS_PER_HOUR} containers per hour.`);
        error.statusCode = 409;
        throw error;
    }
};
const buildCalendarDayRange = (dateValue, timezoneOffsetMinutes = 0) => {
    const match = String(dateValue || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match)
        return null;
    const [, year, month, day] = match;
    const safeOffset = Number.isFinite(Number(timezoneOffsetMinutes)) ? Number(timezoneOffsetMinutes) : 0;
    const startMs = Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0) + safeOffset * 60 * 1000;
    const start = new Date(startMs);
    const end = new Date(startMs + 24 * 60 * 60 * 1000);
    return { start, end, timezoneOffsetMinutes: safeOffset };
};
const getCalendarLocalHour = (value, timezoneOffsetMinutes = 0) => {
    const date = parseBookingDate(value);
    if (!date)
        return null;
    const localDate = new Date(date.getTime() - timezoneOffsetMinutes * 60 * 1000);
    return localDate.getUTCHours();
};
const getCalendarStatusBucket = (status = "") => {
    if (status === "pending_admin_approval")
        return "pending";
    if (["approved_area_assigned", "gate_in_approved"].includes(status))
        return "approved";
    if (["stored_in_assigned_area", "gate_out_requested", "gate_out_approved", "gate_out_reversal_requested"].includes(status))
        return "active";
    if (status === "completed_gate_out_done")
        return "completed";
    return "other";
};
const validateGateOutDate = (booking, outDate) => {
    const parsedIn = parseBookingDate(booking.inDate || booking.expectedArrivalDate || booking.storageStartDate || booking.storedAt || booking.gateInApprovedAt);
    const parsedOut = parseBookingDate(outDate);
    if (!parsedOut) {
        return { valid: false, message: "Please select a valid Date Out and Time Out for the gate-out request." };
    }
    if (!parsedIn) {
        return { valid: false, message: "Booking has no valid In Date. Please ask admin to review the booking." };
    }
    const inCalendarDay = (0, billingDays_js_1.getCalendarDayNumber)(parsedIn);
    const outCalendarDay = (0, billingDays_js_1.getCalendarDayNumber)(parsedOut);
    if (inCalendarDay === null || outCalendarDay === null || outCalendarDay < inCalendarDay) {
        return { valid: false, message: "Date Out cannot be before the booking In Date." };
    }
    return { valid: true, inDate: parsedIn, outDate: parsedOut, days: getDateRangeDays(parsedIn, parsedOut) };
};
const rateMatchesBooking = (rate, booking) => {
    const size = String(booking.containerSize || "");
    const type = normalizeBillingRateKey(booking.containerType);
    const loadStatus = normalizeBillingRateKey(booking.containerLoadStatus);
    const rateSize = String(rate.containerSize || "all");
    const chargeCode = String(rate.chargeCode || "").toUpperCase();
    const codedSize = /^(?:LIFT_ON|LIFT_OFF|STORAGE|CONGESTION)_(20|40)(?:_|$)/.exec(chargeCode)?.[1] || "";
    const effectiveRateSize = codedSize || rateSize;
    const rateContainerType = normalizeBillingRateKey(rate.containerType);
    const rateLoad = normalizeBillingRateKey(rate.loadStatus);
    return (effectiveRateSize === "all" || effectiveRateSize === size)
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
    const rateText = `${rate.chargeCode || ""} ${rate.description || ""}`.toLowerCase();
    if (/documentation|document_fee|doc_fee/.test(rateText))
        return false;
    if (scope === "display_only")
        return false;
    if (scope === "optional_stripping_stuffing") return false;
    if (booking.recordSource === "legacy_migration" && booking.billingStartMethod === "migration_date") {
        const unit = String(rate.unit || "").toLowerCase();
        const isStorageRate = ["storage_day", "per_day"].includes(unit) || /storage/.test(rateText);
        if (!isStorageRate) return false;
    }
    return true;
};
const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const getApprovedPaymentAmount = (booking = {}) => {
    const storedAmount = Math.max(Number(booking.approvedPaymentAmount) || 0, 0);
    if (storedAmount > 0)
        return roundMoney(storedAmount);
    if (booking.billingStatus === "paid_approved")
        return roundMoney(Number(booking.paymentAmount || booking.billingTotal) || 0);
    return 0;
};
const applyApprovedPaymentCredit = (booking, grossTotal) => {
    const approvedAmount = getApprovedPaymentAmount(booking);
    const total = roundMoney(grossTotal);
    const appliedCredit = roundMoney(Math.min(approvedAmount, total));
    const balanceDue = roundMoney(Math.max(total - approvedAmount, 0));
    const creditBalance = roundMoney(Math.max(approvedAmount - total, 0));
    booking.approvedPaymentAmount = approvedAmount;
    booking.paymentCreditAmount = creditBalance;
    booking.paymentBalanceDue = balanceDue;
    booking.paymentAmount = approvedAmount > 0 ? balanceDue : total;
    booking.paymentApplicationStatus = approvedAmount <= 0
        ? "none"
        : balanceDue > 0
            ? "partial_credit"
            : creditBalance > 0
                ? "credit_available"
                : "fully_applied";
    return { approvedAmount, appliedCredit, balanceDue, creditBalance };
};
const archiveCurrentApprovedPayment = (booking, { approvedBy = null, source = "legacy", amountOverride = null } = {}) => {
    const currentPaymentAmount = Number(booking.paymentAmount) || 0;
    const amount = roundMoney(amountOverride !== null
        ? amountOverride
        : currentPaymentAmount > 0
            ? currentPaymentAmount
            : Number(booking.approvedPaymentAmount || 0) <= 0
                ? Number(booking.billingTotal) || 0
                : 0);
    const referenceNumber = String(booking.paymentReferenceNumber || "").trim();
    const receiptNumber = String(booking.receiptNumber || "").trim();
    const alreadyArchived = (booking.paymentTransactions || []).some((item) => {
        const itemReference = String(item.referenceNumber || "").trim();
        const itemReceipt = String(item.receiptNumber || "").trim();
        const sameReference = Boolean(referenceNumber) && itemReference === referenceNumber;
        const sameReceipt = Boolean(receiptNumber) && itemReceipt === receiptNumber;
        const noIdentifiers = !referenceNumber && !receiptNumber && !itemReference && !itemReceipt;
        return sameReference || sameReceipt || (noIdentifiers && roundMoney(item.amount) === amount);
    });
    if (!alreadyArchived && (amount > 0 || referenceNumber || receiptNumber)) {
        booking.paymentTransactions.push({
            amount,
            subtotal: roundMoney(booking.billingSubtotal),
            isVatApplicable: booking.isVatApplicable !== false,
            vatRate: Number(booking.vatRate) || 0,
            vatAmount: roundMoney(booking.vatAmount),
            grossTotal: roundMoney(booking.billingTotal),
            lineItems: (booking.billingLineItems || []).map((item) => item.toObject ? item.toObject() : { ...item }),
            paymentTypeSnapshot: booking.paymentTypeSnapshot || {},
            referenceNumber,
            paymentDate: booking.paymentDate || null,
            remarks: booking.paymentRemarks || "",
            proofs: booking.paymentProofs || [],
            submittedAt: booking.paymentSubmittedAt || null,
            approvedAt: booking.paymentReviewedAt || new Date(),
            approvedBy: booking.paymentReviewedBy || approvedBy || null,
            receiptNumber,
            receiptType: booking.receiptType || (booking.isVatApplicable === false ? "acknowledgement_receipt" : "official_receipt"),
            cashReceived: Number(booking.cashReceived) || 0,
            changeAmount: Number(booking.changeAmount) || 0,
            source,
            archivedAt: new Date(),
        });
    }
};
const clearCurrentPaymentSubmission = (booking) => {
    booking.paymentType = null;
    booking.paymentTypeSnapshot = {};
    booking.paymentReferenceNumber = "";
    booking.paymentDate = null;
    booking.paymentRemarks = "";
    booking.paymentProofs = [];
    booking.paymentSubmittedAt = null;
    booking.paymentReviewedAt = null;
    booking.paymentReviewedBy = null;
    booking.paymentRejectionReason = "";
    booking.cashReceived = 0;
    booking.changeAmount = 0;
    booking.receiptNumber = "";
    booking.receiptGeneratedAt = null;
};
const resolveBillingStage = (booking = {}, requestedStage = "auto") => {
    if (["gate_in", "gate_out"].includes(requestedStage))
        return requestedStage;
    if (booking.recordSource === "legacy_migration")
        return "gate_out";
    if (["gate_out_requested", "gate_out_approved", "gate_out_reversal_requested", "completed_gate_out_done"].includes(String(booking.status || "")))
        return "gate_out";
    return "gate_in";
};
const isLiftOnLiftOffRate = (rate = {}) => /^(LIFT_ON|LIFT_OFF)(?:_|$)/.test(String(rate.chargeCode || "").toUpperCase());
const getLoloPaymentStage = (booking = {}) => booking.loloPaymentStage === "gate_out" ? "gate_out" : "gate_in";
const computeBookingBilling = async (booking, { asOf = new Date(), persist = false, useAsOfAsBillingEnd = false, phase = "auto" } = {}) => {
    const effectiveDate = new Date(asOf);
    const billingStage = resolveBillingStage(booking, phase);
    const activeRates = await BillingRate_js_1.default.find({
        status: "active",
        rateType: normalizeRateType(booking.rateType),
        effectiveDate: { $lte: effectiveDate },
    }).sort({ sortOrder: 1, chargeCode: 1, effectiveDate: -1, createdAt: -1 });
    const applicableRates = activeRates.filter((rate) => rateMatchesBooking(rate, booking) && shouldApplyBillingRate(rate, booking));
    const stagedRates = billingStage === "gate_in"
        ? getLoloPaymentStage(booking) === "gate_in"
            ? applicableRates.filter(isLiftOnLiftOffRate)
            : []
        : applicableRates;
    const matchedRates = getLatestRateByChargeCode(stagedRates);
    const storageDays = billingStage === "gate_out"
        ? getStorageDays(booking, effectiveDate, { useAsOfAsBillingEnd })
        : 0;
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
    const additionalLineItems = billingStage === "gate_out"
        ? (booking.additionalBillingCharges || []).map((item, index) => ({
            rate: null,
            chargeCode: item.chargeCode || `ADDITIONAL_${index + 1}`,
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
        }))
        : [];
    const allLineItems = [...lineItems, ...additionalLineItems];
    const subtotal = Math.round(allLineItems.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
    const configuredVatRate = Number(process.env.VAT_RATE ?? 0.12);
    const isVatApplicable = booking.isVatApplicable !== false;
    const vatRate = isVatApplicable && Number.isFinite(configuredVatRate) && configuredVatRate >= 0 ? configuredVatRate : 0;
    const vatAmount = Math.round(subtotal * vatRate * 100) / 100;
    const total = Math.round((subtotal + vatAmount) * 100) / 100;
    const result = {
        billingStage,
        lineItems: allLineItems,
        subtotal,
        isVatApplicable,
        vatRate,
        vatAmount,
        total,
        days: storageDays,
        computedAt: effectiveDate,
        hasMatchedRates: matchedRates.length > 0,
    };
    if (persist) {
        booking.billingStage = billingStage;
        booking.billingLineItems = allLineItems;
        booking.billingSubtotal = subtotal;
        booking.vatRate = vatRate;
        booking.vatAmount = vatAmount;
        booking.billingTotal = total;
        booking.billingDays = storageDays;
        booking.billingComputedAt = effectiveDate;
        applyApprovedPaymentCredit(booking, total);
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
    ].includes(booking.status)
        && (["unpaid", "payment_rejected", "additional_payment_required"].includes(booking.billingStatus) || Number(booking.approvedPaymentAmount || 0) > 0);
    if (!canRefresh)
        return booking;
    const result = await (0, exports.computeBookingBilling)(booking, { persist: true });
    if (result.hasMatchedRates) {
        if (["unpaid", "payment_rejected", "paid_approved", "additional_payment_required"].includes(booking.billingStatus) && Number(booking.approvedPaymentAmount || 0) > 0) {
            booking.billingStatus = Number(booking.paymentBalanceDue || 0) <= 0 ? "paid_approved" : "unpaid";
        }
        await booking.save();
    }
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
        .populate("assignedArea", "name code isCongestionArea")
        .populate("assignedBlock", "name code teuSlots occupiedSlots bayCount rowCount tierCount containerSize")
        .populate("approvedBy", "name")
        .populate("gateInApprovedBy", "name")
        .populate("gateOutApprovedBy", "name")
        .populate("releasedBy", "name")
        .populate("billingRecomputedBy", "name")
        .populate("overstayFeeWaivedBy", "name")
        .populate("legacyRegisteredBy", "name");
};
const safeBooking = (booking) => {
    const doc = booking.toObject ? booking.toObject() : booking;
    const client = doc.client || {};
    const area = doc.assignedArea || null;
    const block = doc.assignedBlock || null;
    const approvedBy = doc.approvedBy || null;
    const gateInApprovedBy = doc.gateInApprovedBy || null;
    const gateOutApprovedBy = doc.gateOutApprovedBy || null;
    const releasedBy = doc.releasedBy || null;
    const billingRecomputedBy = doc.billingRecomputedBy || null;
    const overstayFeeWaivedBy = doc.overstayFeeWaivedBy || null;
    const legacyRegisteredBy = doc.legacyRegisteredBy || null;
    const gateOutSchedule = getGateOutScheduleInfo(doc);
    return {
        id: String(doc._id),
        client: client?._id ? String(client._id) : doc.client ? String(doc.client) : "",
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
        assignedAreaIsCongestion: Boolean(area?.isCongestionArea),
        assignedBlock: block?._id ? String(block._id) : doc.assignedBlock ? String(doc.assignedBlock) : "",
        assignedBlockName: block?.name || "",
        assignedBlockCode: block?.code || "",
        assignedBay: Number(doc.assignedBay) || 1,
        assignedRow: Number(doc.assignedRow) || 1,
        assignedTier: Number(doc.assignedTier) || 1,
        assignedSlotNumber: doc.assignedSlotNumber || "",
        approvedAt: doc.approvedAt,
        approvedByName: approvedBy?.name || "",
        gateInApprovedAt: doc.gateInApprovedAt,
        gateInApprovedByName: gateInApprovedBy?.name || "",
        gateInPassNumber: doc.gateInPassNumber || (doc.gateInApprovedAt ? buildGatePassNumber("GIN", doc.bookingReference, doc._id) : ""),
        actualContainerNumber: doc.actualContainerNumber || "",
        physicalCondition: doc.physicalCondition || "",
        gateInConditions: doc.gateInConditions || [],
        gateInConditionOther: doc.gateInConditionOther || "",
        gateOutConditions: doc.gateOutConditions || [],
        gateOutConditionOther: doc.gateOutConditionOther || "",
        sealNumber: doc.sealNumber || "",
        sealIntact: doc.sealIntact || "",
        truckPlateNumber: doc.truckPlateNumber || "",
        driverName: doc.driverName || "",
        driverLicenseNumber: doc.driverLicenseNumber || "",
        hauler: doc.hauler || "",
        inspectionRemarks: doc.inspectionRemarks || "",
        storedAt: doc.storedAt,
        storageStartDate: doc.storageStartDate,
        loloPaymentStage: getLoloPaymentStage(doc),
        billingStage: doc.billingStage || resolveBillingStage(doc),
        billingLineItems: doc.billingLineItems || [],
        additionalBillingCharges: (doc.additionalBillingCharges || []).map((item) => ({
            id: String(item._id),
            rate: item.rate ? String(item.rate) : "",
            chargeCode: item.chargeCode || "",
            source: item.source || "manual",
            description: item.description,
            quantity: Number(item.quantity) || 0,
            rateAmount: Number(item.rateAmount) || 0,
            amount: Number(item.amount) || 0,
            notes: item.notes || "",
            addedAt: item.addedAt,
        })),
        billingSubtotal: Number(doc.billingSubtotal) || 0,
        isVatApplicable: doc.isVatApplicable !== false,
        vatRate: Number.isFinite(Number(doc.vatRate)) ? Number(doc.vatRate) : 0.12,
        vatAmount: Number(doc.vatAmount) || 0,
        billingTotal: Number(doc.billingTotal) || 0,
        billingDays: Number(doc.billingDays) || 0,
        billingComputedAt: doc.billingComputedAt,
        billingPreviousTotal: Number(doc.billingPreviousTotal) || 0,
        billingRecomputedAt: doc.billingRecomputedAt,
        billingRecomputedByName: billingRecomputedBy?.name || "",
        billingRecomputeReason: doc.billingRecomputeReason || "",
        billingRecomputeCount: Number(doc.billingRecomputeCount) || 0,
        paymentAmount: Number(doc.paymentAmount) || 0,
        approvedPaymentAmount: Number(doc.approvedPaymentAmount) || 0,
        paymentCreditAmount: Number(doc.paymentCreditAmount) || 0,
        paymentBalanceDue: Number(doc.paymentBalanceDue ?? doc.paymentAmount) || 0,
        paymentApplicationStatus: doc.paymentApplicationStatus || "none",
        paymentTransactions: (doc.paymentTransactions || []).map((item) => ({
            id: String(item._id),
            amount: Number(item.amount) || 0,
            subtotal: Number(item.subtotal) || 0,
            isVatApplicable: item.isVatApplicable !== false,
            vatRate: Number(item.vatRate) || 0,
            vatAmount: Number(item.vatAmount) || 0,
            grossTotal: Number(item.grossTotal) || 0,
            lineItems: item.lineItems || [],
            paymentTypeSnapshot: item.paymentTypeSnapshot || {},
            referenceNumber: item.referenceNumber || "",
            paymentDate: item.paymentDate,
            remarks: item.remarks || "",
            proofs: item.proofs || [],
            submittedAt: item.submittedAt,
            approvedAt: item.approvedAt,
            receiptNumber: item.receiptNumber || "",
            receiptType: item.receiptType || "official_receipt",
            cashReceived: Number(item.cashReceived) || 0,
            changeAmount: Number(item.changeAmount) || 0,
            source: item.source || "legacy",
        })),
        paymentType: doc.paymentType ? String(doc.paymentType?._id || doc.paymentType) : "",
        paymentTypeSnapshot: doc.paymentTypeSnapshot || {},
        paymentReferenceNumber: doc.paymentReferenceNumber || "",
        paymentDate: doc.paymentDate,
        paymentRemarks: doc.paymentRemarks || "",
        paymentProofs: doc.paymentProofs || [],
        paymentSubmittedAt: doc.paymentSubmittedAt,
        paymentRejectionReason: doc.paymentRejectionReason || "",
        cashReceived: Number(doc.cashReceived) || 0,
        changeAmount: Number(doc.changeAmount) || 0,
        receiptNumber: doc.receiptNumber || "",
        receiptType: doc.receiptType || (doc.isVatApplicable === false ? "acknowledgement_receipt" : "official_receipt"),
        receiptGeneratedAt: doc.receiptGeneratedAt,
        gateOutRequestedAt: doc.gateOutRequestedAt,
        gateOutRequestRemarks: doc.gateOutRequestRemarks || "",
        gateOutRejectedAt: doc.gateOutRejectedAt,
        gateOutRejectionReason: doc.gateOutRejectionReason || "",
        gateOutApprovedAt: doc.gateOutApprovedAt,
        gateOutApprovedByName: gateOutApprovedBy?.name || "",
        gateOutPassNumber: doc.gateOutPassNumber || (doc.gateOutApprovedAt ? buildGatePassNumber("GOUT", doc.bookingReference, doc._id) : ""),
        gateOutGracePeriodMinutes: gateOutSchedule.gracePeriodMinutes,
        gateOutScheduleStatus: gateOutSchedule.status,
        gateOutOverstayStartedAt: gateOutSchedule.overstayStartedAt,
        gateOutOverstayDurationMinutes: gateOutSchedule.overstayDurationMinutes,
        isOverstaying: gateOutSchedule.isOverstaying,
        overstayFeeWaived: Boolean(doc.overstayFeeWaived),
        overstayFeeWaivedAt: doc.overstayFeeWaivedAt,
        overstayFeeWaivedByName: overstayFeeWaivedBy?.name || "",
        overstayFeeWaiverReason: doc.overstayFeeWaiverReason || "",
        serverTime: gateOutSchedule.serverTime,
        gateOutRemarks: doc.gateOutRemarks || "",
        gateOutReversalRequestedAt: doc.gateOutReversalRequestedAt,
        gateOutReversalRequestReason: doc.gateOutReversalRequestReason || "",
        gateOutReversalReviewedAt: doc.gateOutReversalReviewedAt,
        gateOutReversalDecision: doc.gateOutReversalDecision || "",
        gateOutReversalAdminRemarks: doc.gateOutReversalAdminRemarks || "",
        gateOutReversalCount: Number(doc.gateOutReversalCount) || 0,
        releasedAt: doc.releasedAt,
        releasedByName: releasedBy?.name || "",
        releaseRemarks: doc.releaseRemarks || "",
        releaseReport: doc.releaseReport ? String(doc.releaseReport?._id || doc.releaseReport) : "",
        reportGeneratedAt: doc.reportGeneratedAt,
        revenueRecordedAt: doc.revenueRecordedAt,
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
    const recipient = populated.client?._id || populated.client;
    if (!recipient)
        return;
    await (0, notificationService_js_1.createClientNotification)({
        recipient,
        type: options.notificationType || "booking",
        title,
        message,
        booking: populated._id || null,
        bookingReference: populated.bookingReference || populated.bookingNumber || "",
        containerNumber: populated.containerNumber || "",
        actionPath: options.actionPath || "/booking-history",
        metadata: {
            status: populated.status || "",
            billingStatus: populated.billingStatus || "",
            details,
        },
    });
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
const buildReceiptNumber = async (isVatApplicable = true) => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const prefix = isVatApplicable ? "OR" : "AR";
    const dateCode = `${yyyy}${mm}${dd}`;
    const dayStart = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
    const count = await Booking_js_1.default.countDocuments({ receiptGeneratedAt: { $gte: dayStart } });
    return `${prefix}-${dateCode}-${String(count + 1).padStart(5, "0")}`;
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
const getYardSpaceAvailability = async (containerSize, { areaType = "regular", excludeBookingId = null } = {}) => {
    const blocks = await YardBlock_js_1.default.find({ status: "active" })
        .select("containerSize teuSlots status area")
        .populate("area", "name code status isCongestionArea");
    const eligibleBlocks = blocks.filter((block) => {
        if (!block.area || block.area.status !== "active") return false;
        const isCongestionArea = Boolean(block.area.isCongestionArea);
        if (areaType === "congestion") return isCongestionArea;
        if (areaType === "all") return true;
        return !isCongestionArea;
    });
    if (eligibleBlocks.length === 0) {
        return { hasAvailableSpace: false, availableCapacity: 0, blockCount: 0 };
    }
    let availableCapacity = 0;
    let hasAvailableSpace = false;
    for (const block of eligibleBlocks) {
        const bookingFilter = activeBookingFilterForBlock(block._id);
        if (excludeBookingId) bookingFilter._id = { $ne: excludeBookingId };
        const [inventoryContainers, bookingContainers, confirmedPreAdvices] = await Promise.all([
            InventoryContainer_js_1.default.find({ block: block._id, status: { $ne: "released" } }).select("containerSize"),
            Booking_js_1.default.find(bookingFilter).select("containerSize"),
            PreAdvice_js_1.default.find({ plannedBlock: block._id, status: "confirmed" }).select("containerSize"),
        ]);
        const usedCapacity = [...inventoryContainers, ...bookingContainers, ...confirmedPreAdvices].reduce((total, item) => total + getYardCapacityUsage(item.containerSize, block.containerSize), 0);
        const requiredCapacity = getYardCapacityUsage(containerSize, block.containerSize);
        const remaining = Math.max(Number(block.teuSlots) - usedCapacity, 0);
        availableCapacity += remaining;
        if (remaining >= requiredCapacity) hasAvailableSpace = true;
    }
    return {
        hasAvailableSpace,
        availableCapacity: Math.round(availableCapacity * 100) / 100,
        blockCount: eligibleBlocks.length,
    };
};
const resolveCongestionSurchargeOption = async (booking, { requireCongestionSpace = true } = {}) => {
    const regularYard = await getYardSpaceAvailability(booking.containerSize, {
        areaType: "regular",
        excludeBookingId: booking._id,
    });
    if (regularYard.hasAvailableSpace) {
        return { available: false, reason: "Regular yard space is still available.", regularYard };
    }
    const congestionYard = await getYardSpaceAvailability(booking.containerSize, {
        areaType: "congestion",
        excludeBookingId: booking._id,
    });
    if (congestionYard.blockCount === 0) {
        return {
            available: false,
            reason: "Create and activate a designated congestion yard area before applying the surcharge.",
            regularYard,
            congestionYard,
        };
    }
    if (requireCongestionSpace && !congestionYard.hasAvailableSpace) {
        return {
            available: false,
            reason: "The designated congestion yard area has no available space.",
            regularYard,
            congestionYard,
        };
    }
    const rate = await BillingRate_js_1.default.findOne({
        status: "active",
        rateType: normalizeRateType(booking.rateType),
        effectiveDate: { $lte: new Date() },
        billingScope: "display_only",
        containerSize: String(booking.containerSize),
        $or: [
            { chargeCode: `CONGESTION_${booking.containerSize}` },
            { description: { $regex: "congestion", $options: "i" } },
        ],
    }).sort({ effectiveDate: -1, createdAt: -1 });
    if (!rate) {
        return {
            available: false,
            reason: `No active ${booking.containerSize}ft congestion surcharge is configured.`,
            regularYard,
            congestionYard,
        };
    }
    return {
        available: true,
        reason: "Regular yard space is unavailable. Assign the container to a designated congestion area.",
        regularYard,
        congestionYard,
        rate: {
            id: String(rate._id),
            chargeCode: rate.chargeCode,
            description: rate.description,
            rateAmount: Number(rate.rateAmount) || 0,
            containerSize: rate.containerSize,
            rateType: normalizeRateType(rate.rateType),
        },
    };
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
    const requestedSlotKeys = getReservedSlotKeys({ bay: nextBay, row: nextRow, tier: nextTier, containerSize, yardContainerSize: block.containerSize });
    if (requestedSlotKeys.length === 2 && nextBay + 1 > Number(block.bayCount || 1)) {
        const error = new Error("A 40ft container needs two adjacent 20ft slots. Select a bay with an available next bay.");
        error.statusCode = 400;
        throw error;
    }
    const [inventoryContainers, bookingContainers, confirmedPreAdvices] = await Promise.all([
        InventoryContainer_js_1.default.find({ block: block._id, status: { $ne: "released" } }).select("containerSize bay row tier"),
        Booking_js_1.default.find({ _id: { $ne: bookingId }, assignedBlock: block._id, status: { $nin: TERMINAL_BOOKING_STATUSES } }).select("containerSize assignedBay assignedRow assignedTier"),
        PreAdvice_js_1.default.find({ plannedBlock: block._id, status: "confirmed" }).select("containerSize plannedBay plannedRow plannedTier"),
    ]);
    const occupiedKeys = new Set([
        ...inventoryContainers.flatMap((item) => getReservedSlotKeys({ bay: item.bay, row: item.row, tier: item.tier, containerSize: item.containerSize, yardContainerSize: block.containerSize })),
        ...bookingContainers.flatMap((item) => getReservedSlotKeys({ bay: item.assignedBay, row: item.assignedRow, tier: item.assignedTier, containerSize: item.containerSize, yardContainerSize: block.containerSize })),
        ...confirmedPreAdvices.flatMap((item) => getReservedSlotKeys({ bay: item.plannedBay, row: item.plannedRow, tier: item.plannedTier, containerSize: item.containerSize, yardContainerSize: block.containerSize })),
    ]);
    if (requestedSlotKeys.some((key) => occupiedKeys.has(key))) {
        const error = new Error("The selected location does not have the required adjacent slot capacity.");
        error.statusCode = 409;
        throw error;
    }
    const usedCapacity = [...inventoryContainers, ...bookingContainers, ...confirmedPreAdvices].reduce((total, item) => total + getYardCapacityUsage(item.containerSize, block.containerSize), 0);
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
const getReservedSlotKeys = ({ bay, row, tier, containerSize, yardContainerSize }) => {
    const firstBay = Number(bay) || 1;
    const keys = [getSlotKey(firstBay, row, tier)];
    if (Number(containerSize) === 40 && Number(yardContainerSize) === 20) {
        keys.push(getSlotKey(firstBay + 1, row, tier));
    }
    return keys;
};
const getYardBlockSlots = async (req, res) => {
    const block = await YardBlock_js_1.default.findById(req.params.blockId).populate("area", "name code isCongestionArea");
    if (!block) {
        return res.status(404).json({ success: false, message: "Yard block not found." });
    }
    const [inventorySlots, bookingSlots, preAdviceSlots] = await Promise.all([
        InventoryContainer_js_1.default.find({ block: block._id, status: { $ne: "released" } }).select("containerNumber containerSize bay row tier status"),
        Booking_js_1.default.find({ assignedBlock: block._id, status: { $nin: TERMINAL_BOOKING_STATUSES } }).select("bookingReference containerNumber containerSize assignedBay assignedRow assignedTier status"),
        PreAdvice_js_1.default.find({ plannedBlock: block._id, status: "confirmed" }).select("preAdviceNumber containerNumber containerSize plannedBay plannedRow plannedTier status"),
    ]);
    const slots = [
        ...inventorySlots.flatMap((item) => getReservedSlotKeys({ bay: item.bay, row: item.row, tier: item.tier, containerSize: item.containerSize, yardContainerSize: block.containerSize }).map((key, index) => ({
            key,
            bay: (Number(item.bay) || 1) + index,
            row: Number(item.row) || 1,
            tier: Number(item.tier) || 1,
            type: "occupied",
            status: item.status,
            containerNumber: item.containerNumber,
            reference: item.containerNumber,
        }))),
        ...bookingSlots.flatMap((item) => getReservedSlotKeys({ bay: item.assignedBay, row: item.assignedRow, tier: item.assignedTier, containerSize: item.containerSize, yardContainerSize: block.containerSize }).map((key, index) => ({
            key,
            bay: (Number(item.assignedBay) || 1) + index,
            row: Number(item.assignedRow) || 1,
            tier: Number(item.assignedTier) || 1,
            type: item.status === "stored_in_assigned_area" ? "occupied" : "reserved",
            status: item.status,
            containerNumber: item.containerNumber,
            reference: item.bookingReference,
        }))),
        ...preAdviceSlots.flatMap((item) => getReservedSlotKeys({ bay: item.plannedBay, row: item.plannedRow, tier: item.plannedTier, containerSize: item.containerSize, yardContainerSize: block.containerSize }).map((key, index) => ({
            key,
            bay: (Number(item.plannedBay) || 1) + index,
            row: Number(item.plannedRow) || 1,
            tier: Number(item.plannedTier) || 1,
            type: "reserved",
            status: item.status,
            containerNumber: item.containerNumber,
            reference: item.preAdviceNumber,
        }))),
    ];
    return res.json({
        success: true,
        block: {
            id: String(block._id),
            area: block.area?._id ? String(block.area._id) : String(block.area),
            areaName: block.area?.name || "",
            isCongestionArea: Boolean(block.area?.isCongestionArea),
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
    const { containerNumber, containerSize, containerType, containerLoadStatus, serviceType, rateType, shippingLine, truckPlateNumber, driverName, driverLicenseNumber, hauler, blNumber, vesselVoyage, cargoDescription, weight, expectedArrivalDate, inDate, outDate, clientRemarks, } = req.body;
    const requiredFields = [containerNumber, containerSize, containerType, rateType, shippingLine, inDate || expectedArrivalDate, truckPlateNumber, driverName, weight];
    if (requiredFields.some((value) => !String(value || "").trim())) {
        return res.status(400).json({ success: false, message: "Please complete all required booking fields." });
    }
    if (![20, 40].includes(Number(containerSize))) {
        return res.status(400).json({ success: false, message: "Container size must be 20ft or 40ft." });
    }
    if (!["local", "international"].includes(String(rateType || "").trim().toLowerCase())) {
        return res.status(400).json({ success: false, message: "Select whether this booking is Local or International." });
    }
    if (!Number.isFinite(Number(weight)) || Number(weight) <= 0) {
        return res.status(400).json({ success: false, message: "Container weight is required and must be greater than zero." });
    }
    const dateRange = validateBookingDateRange({ inDate, outDate, expectedArrivalDate });
    if (!dateRange.valid) {
        return res.status(400).json({ success: false, message: dateRange.message });
    }
    try {
        await ensureBookingHourCapacity(dateRange.inDate);
    }
    catch (error) {
        return handleValidationError(error, res);
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
    if (!req.files?.deliveryOrder?.[0]) {
        return res.status(400).json({
            success: false,
            message: "Delivery Order or another supporting delivery document is required for pre-advice verification.",
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
        rateType: normalizeRateType(rateType),
        shippingLine,
        truckPlateNumber: truckPlateNumber || "",
        driverName: driverName || "",
        driverLicenseNumber: driverLicenseNumber || "",
        hauler: hauler || "",
        blNumber: blNumber || "",
        vesselVoyage: vesselVoyage || "",
        cargoDescription: cargoDescription || "",
        weight: Number(weight),
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
    const { containerNumber, containerSize, containerType, containerLoadStatus, serviceType, rateType, shippingLine, truckPlateNumber, driverName, driverLicenseNumber, hauler, blNumber, vesselVoyage, cargoDescription, weight, expectedArrivalDate, inDate, outDate, clientRemarks, } = req.body;
    const requiredFields = [containerNumber, containerSize, containerType, rateType, shippingLine, inDate || expectedArrivalDate, truckPlateNumber, driverName, weight];
    if (requiredFields.some((value) => !String(value || "").trim())) {
        return res.status(400).json({ success: false, message: "Please complete all required booking fields before resubmitting." });
    }
    if (![20, 40].includes(Number(containerSize))) {
        return res.status(400).json({ success: false, message: "Container size must be 20ft or 40ft." });
    }
    if (!["local", "international"].includes(String(rateType || "").trim().toLowerCase())) {
        return res.status(400).json({ success: false, message: "Select whether this booking is Local or International." });
    }
    if (!Number.isFinite(Number(weight)) || Number(weight) <= 0) {
        return res.status(400).json({ success: false, message: "Container weight is required and must be greater than zero." });
    }
    const dateRange = validateBookingDateRange({ inDate, outDate, expectedArrivalDate });
    if (!dateRange.valid) {
        return res.status(400).json({ success: false, message: dateRange.message });
    }
    try {
        await ensureBookingHourCapacity(dateRange.inDate, booking._id);
    }
    catch (error) {
        return handleValidationError(error, res);
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
    booking.rateType = normalizeRateType(rateType);
    booking.shippingLine = shippingLine;
    booking.truckPlateNumber = truckPlateNumber || "";
    booking.driverName = driverName || "";
    booking.driverLicenseNumber = driverLicenseNumber || "";
    booking.hauler = hauler || "";
    booking.blNumber = blNumber || "";
    booking.vesselVoyage = vesselVoyage || "";
    booking.cargoDescription = cargoDescription || "";
    booking.weight = Number(weight);
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
    const { status, billingStatus, loadStatus, rateType, recordSource, search } = req.query;
    const query = {};
    if (status && status !== "all")
        query.status = status;
    if (billingStatus && billingStatus !== "all")
        query.billingStatus = billingStatus;
    if (["empty", "laden"].includes(String(loadStatus || "").toLowerCase()))
        query.containerLoadStatus = String(loadStatus).toLowerCase();
    if (["local", "international"].includes(String(rateType || "").toLowerCase()))
        query.rateType = String(rateType).toLowerCase();
    const normalizedRecordSource = String(recordSource || "").toLowerCase();
    if (normalizedRecordSource === "client_booking") {
        query.$and = [
            ...(query.$and || []),
            { $or: [{ recordSource: "client_booking" }, { recordSource: { $exists: false } }, { recordSource: "" }] },
        ];
    }
    else if (["admin_manual", "legacy_migration"].includes(normalizedRecordSource)) {
        query.recordSource = normalizedRecordSource;
    }
    if (search) {
        const term = String(search).trim();
        query.$or = [
            { bookingReference: { $regex: term, $options: "i" } },
            { bookingNumber: { $regex: term, $options: "i" } },
            { legacyRegistrationNumber: { $regex: term, $options: "i" } },
            { containerNumber: { $regex: term, $options: "i" } },
            { shippingLine: { $regex: term, $options: "i" } },
        ];
    }
    const bookings = await populateBooking(Booking_js_1.default.find(query)).sort({ createdAt: -1 }).limit(300);
    await refreshComputedBillingList(bookings);
    return res.json({ success: true, bookings: bookings.map(safeBooking) });
};
exports.listAdminBookings = listAdminBookings;
const getAdminBookingCalendar = async (req, res) => {
    const today = new Date();
    const fallbackDate = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
    const selectedDate = String(req.query.date || fallbackDate);
    const timezoneOffset = Number(req.query.timezoneOffset || 0);
    const range = buildCalendarDayRange(selectedDate, timezoneOffset);
    if (!range)
        return res.status(400).json({ success: false, message: "Please provide a valid schedule date in YYYY-MM-DD format." });
    const bookings = await populateBooking(Booking_js_1.default.find({
        inDate: { $gte: range.start, $lt: range.end },
        status: { $nin: ["rejected", "cancelled"] },
        recordSource: { $ne: "legacy_migration" },
    })).sort({ inDate: 1, createdAt: 1, bookingReference: 1 });
    const safeBookings = bookings.map(safeBooking);
    const grouped = new Map();
    const overflow = [];
    for (const booking of safeBookings) {
        const hour = getCalendarLocalHour(booking.inDate || booking.expectedArrivalDate, timezoneOffset);
        if (hour === null)
            continue;
        if (!grouped.has(hour))
            grouped.set(hour, []);
        const entries = grouped.get(hour);
        if (entries.length < MAX_CONTAINERS_PER_HOUR) {
            entries.push(booking);
        }
        else {
            overflow.push(booking);
        }
    }
    const rows = Array.from({ length: 24 }, (_, hour) => {
        const rowBookings = grouped.get(hour) || [];
        return {
            hour,
            slots: Array.from({ length: MAX_CONTAINERS_PER_HOUR }, (_, slotIndex) => ({
                slotNumber: slotIndex + 1,
                booking: rowBookings[slotIndex] || null,
            })),
        };
    });
    const summary = { total: safeBookings.length, pending: 0, approved: 0, active: 0, completed: 0, other: 0 };
    for (const booking of safeBookings) {
        const bucket = getCalendarStatusBucket(booking.status);
        summary[bucket] = (summary[bucket] || 0) + 1;
    }
    return res.json({
        success: true,
        date: selectedDate,
        maxSlotsPerHour: MAX_CONTAINERS_PER_HOUR,
        rows,
        summary,
        overflowCount: overflow.length,
    });
};
exports.getAdminBookingCalendar = getAdminBookingCalendar;
const getAdminBooking = async (req, res) => {
    const booking = await populateBooking(Booking_js_1.default.findById(req.params.id));
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    await refreshComputedBilling(booking);
    return res.json({ success: true, booking: safeBooking(booking) });
};
exports.getAdminBooking = getAdminBooking;
const deleteBooking = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });

    const previousBlockId = booking.assignedBlock ? String(booking.assignedBlock) : "";
    const clientId = booking.client;
    const bookingReference = booking.bookingReference;
    const fileReferences = [...(booking.documents || []), ...(booking.paymentProofs || [])]
        .map((document) => document.publicId || document.secureUrl || document.url)
        .filter(Boolean);

    await ReleaseReport_js_1.default.deleteMany({ booking: booking._id });
    await Booking_js_1.default.deleteOne({ _id: booking._id });

    await Promise.allSettled(fileReferences.map((fileReference) => (0, localFileStorage_js_1.deleteLocalFile)(fileReference)));
    if (previousBlockId)
        await recalculateBlockOccupancy(previousBlockId);

    const payload = {
        id: String(booking._id),
        bookingReference,
        containerNumber: booking.containerNumber,
        previousBlockId,
    };
    (0, socket_js_1.emitToAdmins)("booking:deleted", payload);
    (0, socket_js_1.emitToAdmins)("yard:slot_released", payload);
    if (clientId)
        (0, socket_js_1.emitToUser)(clientId, "booking:deleted", payload);

    return res.json({ success: true, message: `Booking ${bookingReference} deleted successfully.`, booking: payload });
};
exports.deleteBooking = deleteBooking;
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
    const requestedLoloPaymentStage = String(req.body.loloPaymentStage || booking.loloPaymentStage || "gate_in").trim().toLowerCase();
    if (!["gate_in", "gate_out"].includes(requestedLoloPaymentStage)) {
        return res.status(400).json({ success: false, message: "LOLO payment collection must be set to Gate-In or Gate-Out." });
    }
    booking.loloPaymentStage = requestedLoloPaymentStage;
    const assignedToCongestionArea = Boolean(plan.area.isCongestionArea);
    let congestionOption = null;
    if (assignedToCongestionArea) {
        congestionOption = await resolveCongestionSurchargeOption(booking, { requireCongestionSpace: false });
        if (!congestionOption.available || !congestionOption.rate) {
            return res.status(400).json({
                success: false,
                message: congestionOption.reason || "Congestion surcharge is not available for this booking.",
            });
        }
        const existingCongestionCharge = (booking.additionalBillingCharges || []).find((item) => item.source === "congestion_surcharge");
        if (existingCongestionCharge) {
            existingCongestionCharge.rate = congestionOption.rate.id;
            existingCongestionCharge.chargeCode = congestionOption.rate.chargeCode;
            existingCongestionCharge.description = congestionOption.rate.description || "Congestion Surcharge";
            existingCongestionCharge.quantity = 1;
            existingCongestionCharge.rateAmount = congestionOption.rate.rateAmount;
            existingCongestionCharge.amount = congestionOption.rate.rateAmount;
            existingCongestionCharge.notes = "Automatically applied during pre-advice assignment to the designated congestion area.";
            existingCongestionCharge.addedBy = req.user._id;
            existingCongestionCharge.addedAt = new Date();
        }
        else {
            booking.additionalBillingCharges.push({
                rate: congestionOption.rate.id,
                chargeCode: congestionOption.rate.chargeCode,
                source: "congestion_surcharge",
                description: congestionOption.rate.description || "Congestion Surcharge",
                quantity: 1,
                rateAmount: congestionOption.rate.rateAmount,
                amount: congestionOption.rate.rateAmount,
                notes: "Automatically applied during pre-advice assignment to the designated congestion area.",
                addedBy: req.user._id,
                addedAt: new Date(),
            });
        }
    }
    else {
        booking.additionalBillingCharges = (booking.additionalBillingCharges || []).filter((item) => item.source !== "congestion_surcharge");
    }
    const billingResult = await (0, exports.computeBookingBilling)(booking, { persist: true, phase: "gate_in" });
    addHistory(booking, {
        remarks: booking.loloPaymentStage === "gate_out"
            ? `Booking approved and assigned to ${assignedToCongestionArea ? "the designated congestion area" : "a regular yard area"}. LOLO collection is deferred to Gate-Out. Storage, congestion, and other charges are also payable only at Gate-Out.`
            : billingResult.hasMatchedRates
                ? `Booking approved and assigned to ${assignedToCongestionArea ? "the designated congestion area" : "a regular yard area"}. Gate-In LOLO billing is PHP ${billingResult.total.toLocaleString()}. Storage, congestion, and other charges will be computed and collected during Gate-Out.`
                : `Booking approved and assigned to ${assignedToCongestionArea ? "the designated congestion area" : "a regular yard area"}. Configure matching active Lift On and Lift Off rates before Gate-In payment and approval. Storage and other charges remain payable only at Gate-Out.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await recalculateBlockOccupancy(plan.block._id);
    if (previousBlockId && previousBlockId !== String(plan.block._id))
        await recalculateBlockOccupancy(previousBlockId);
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
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
    return res.json({ success: true, message: booking.loloPaymentStage === "gate_out"
        ? "Booking approved and yard area assigned. LOLO payment will be collected at Gate-Out."
        : "Booking approved, yard area assigned, and Gate-In LOLO billing initialized.", booking: payload });
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
    booking.additionalBillingCharges = (booking.additionalBillingCharges || []).filter((item) => item.source !== "congestion_surcharge");
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
    const loloPaymentStage = getLoloPaymentStage(booking);
    let gateInBillingResult = null;
    if (loloPaymentStage === "gate_in") {
        if (booking.billingStage !== "gate_in" || !Array.isArray(booking.billingLineItems) || booking.billingLineItems.length === 0) {
            gateInBillingResult = await (0, exports.computeBookingBilling)(booking, { persist: true, phase: "gate_in" });
        }
        else {
            gateInBillingResult = {
                hasMatchedRates: booking.billingLineItems.some((item) => /^(LIFT_ON|LIFT_OFF)(?:_|$)/.test(String(item.chargeCode || "").toUpperCase())),
                total: Number(booking.billingTotal) || 0,
            };
            applyApprovedPaymentCredit(booking, booking.billingTotal);
        }
        if (!gateInBillingResult.hasMatchedRates || Number(gateInBillingResult.total || 0) <= 0) {
            return res.status(400).json({ success: false, message: "Gate-In requires active Lift On and Lift Off billing rates before approval when LOLO is collected at Gate-In." });
        }
        if (booking.billingStatus !== "paid_approved" || Number(booking.paymentBalanceDue || 0) > 0) {
            await booking.save();
            return res.status(403).json({ success: false, message: `Gate-In LOLO payment must be fully paid and approved before Gate-In. Balance due: PHP ${Number(booking.paymentBalanceDue || booking.paymentAmount || 0).toLocaleString()}.` });
        }
    }
    const actualContainerNumber = normalizeContainerNumber(req.body.actualContainerNumber || booking.containerNumber);
    if (actualContainerNumber !== booking.containerNumber) {
        return res.status(400).json({ success: false, message: "Actual container number must match the approved booking." });
    }
    if (!booking.truckPlateNumber || !booking.driverName) {
        return res.status(400).json({ success: false, message: "Truck plate number and driver name must be added in the booking before Gate-In." });
    }
    const receivedAt = new Date();
    const gateInConditions = normalizeConditionSelections(req.body.gateInConditions || req.body.conditions);
    const gateInConditionOther = String(req.body.gateInConditionOther || "").trim();
    booking.status = "gate_in_approved";
    booking.gateInApprovedAt = receivedAt;
    booking.gateInApprovedBy = req.user._id;
    booking.gateInPassNumber = booking.gateInPassNumber || buildGatePassNumber("GIN", booking.bookingReference, booking._id);
    booking.actualContainerNumber = actualContainerNumber;
    booking.gateInConditions = gateInConditions.length ? gateInConditions : ["GOOD"];
    booking.gateInConditionOther = gateInConditionOther;
    booking.physicalCondition = buildConditionSummary(booking.gateInConditions, gateInConditionOther);
    booking.sealNumber = req.body.sealNumber || "";
    booking.sealIntact = normalizeYesNo(req.body.sealIntact || booking.sealIntact);
    booking.truckPlateNumber = booking.truckPlateNumber || req.body.truckPlateNumber || "";
    booking.driverName = booking.driverName || req.body.driverName || "";
    booking.driverLicenseNumber = booking.driverLicenseNumber || req.body.driverLicenseNumber || "";
    booking.hauler = booking.hauler || req.body.hauler || "";
    booking.inspectionRemarks = req.body.inspectionRemarks || "";
    addHistory(booking, {
        remarks: loloPaymentStage === "gate_in"
            ? `Gate-In approved under pass ${booking.gateInPassNumber} after LOLO payment verification. Container added to Inventory and is awaiting storage confirmation.`
            : `Gate-In approved under pass ${booking.gateInPassNumber}. LOLO payment is deferred to Gate-Out by admin selection. Container added to Inventory and is awaiting storage confirmation.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    await booking.populate("gateInApprovedBy", "name");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:gate_in_approved", payload);
    (0, socket_js_1.emitToAdmins)("inventory:container_created", payload);
    (0, socket_js_1.emitToAdmins)("inventory:updated", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:gate_in_approved", payload);
    await notifyClient(booking, "Gate-In approved", loloPaymentStage === "gate_in"
        ? "Your LOLO payment was verified and the container passed Gate-In inspection. It is now listed in Inventory for storage confirmation."
        : "The container passed Gate-In inspection. Your LOLO payment is scheduled for Gate-Out together with storage and other Gate-Out charges.", [
        { label: "Gate-In Pass No.", value: booking.gateInPassNumber },
        { label: "Container", value: booking.containerNumber },
        { label: "Truck Plate", value: booking.truckPlateNumber },
        { label: "Assigned Slot", value: booking.assignedSlotNumber },
        { label: "Rate Classification", value: booking.rateType === "international" ? "International" : "Local" },
    ]);
    return res.json({ success: true, message: "Gate-In approved. Container added to Inventory.", booking: payload });
};
exports.approveBookingGateIn = approveBookingGateIn;
const rejectBookingGateIn = async (req, res) => {
    const reason = String(req.body.reason || "").trim();
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (booking.status !== "approved_area_assigned") {
        return res.status(400).json({ success: false, message: "Only bookings awaiting gate-in can be rejected in this module." });
    }
    if (!reason) {
        return res.status(400).json({ success: false, message: "Gate-in rejection reason is required." });
    }
    const previousBlockId = booking.assignedBlock ? String(booking.assignedBlock) : "";
    booking.status = "rejected";
    booking.rejectionReason = `Gate-In rejected: ${reason}`;
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
    booking.additionalBillingCharges = (booking.additionalBillingCharges || []).filter((item) => item.source !== "congestion_surcharge");
    addHistory(booking, { remarks: `Gate-In rejected: ${reason}. Yard reservation released.`, changedBy: req.user._id });
    await booking.save();
    if (previousBlockId) await recalculateBlockOccupancy(previousBlockId);
    await booking.populate("client", "name email companyName phoneNumber");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:gate_in_rejected", payload);
    (0, socket_js_1.emitToAdmins)("yard:slot_released", { ...payload, previousBlockId });
    (0, socket_js_1.emitToAdmins)("inventory:updated", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:gate_in_rejected", payload);
    await notifyClient(booking, "Gate-In rejected", "Your gate-in request was rejected. Review the reason before resubmitting the booking.", [
        { label: "Reason", value: reason },
    ]);
    return res.json({ success: true, message: "Gate-In rejected and yard reservation released.", booking: payload });
};
exports.rejectBookingGateIn = rejectBookingGateIn;
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
    const billingResult = await (0, exports.computeBookingBilling)(booking, { persist: true, phase: "gate_in" });
    addHistory(booking, {
        remarks: getLoloPaymentStage(booking) === "gate_out"
            ? `${wasAlreadyStored ? "Stored container billing refreshed" : "Container stored in assigned yard location"}. LOLO, storage, congestion, and other charges are payable at Gate-Out.`
            : billingResult?.hasMatchedRates
                ? `${wasAlreadyStored ? "Stored container Gate-In billing refreshed" : "Container stored in assigned yard location"}. Gate-In LOLO remains PHP ${billingResult.total.toLocaleString()}. Storage and other charges are deferred until Gate-Out.`
                : "Container stored in the assigned yard location. Configure matching active Lift On and Lift Off rates for Gate-In billing; storage and other charges will be computed at Gate-Out.",
        changedBy: req.user._id,
    });
    await booking.save();
    await recalculateBlockOccupancy(booking.assignedBlock);
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
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
const updateBookingRateClassification = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (!["unpaid", "payment_rejected"].includes(booking.billingStatus)) {
        return res.status(400).json({ success: false, message: "Local or International classification can no longer be changed after payment is submitted or approved." });
    }
    const requestedRateType = String(req.body.rateType || "").trim().toLowerCase();
    if (!["local", "international"].includes(requestedRateType)) {
        return res.status(400).json({ success: false, message: "Select Local or International as the rate classification." });
    }
    const previousRateType = normalizeRateType(booking.rateType);
    booking.serviceType = normalizeBookingServiceType(booking.serviceType);
    booking.rateType = requestedRateType;
    const congestionCharge = (booking.additionalBillingCharges || []).find((item) => item.source === "congestion_surcharge");
    if (congestionCharge) {
        const congestionRate = await BillingRate_js_1.default.findOne({
            status: "active",
            rateType: requestedRateType,
            effectiveDate: { $lte: new Date() },
            billingScope: "display_only",
            containerSize: String(booking.containerSize),
            $or: [
                { chargeCode: `CONGESTION_${booking.containerSize}` },
                { description: { $regex: "congestion", $options: "i" } },
            ],
        }).sort({ effectiveDate: -1, createdAt: -1 });
        if (!congestionRate) {
            return res.status(400).json({
                success: false,
                message: `Cannot change to ${requestedRateType === "international" ? "International" : "Local"}. Configure an active ${booking.containerSize}ft congestion surcharge for that classification first.`,
            });
        }
        congestionCharge.rate = congestionRate._id;
        congestionCharge.chargeCode = congestionRate.chargeCode;
        congestionCharge.description = congestionRate.description || "Congestion Surcharge";
        congestionCharge.quantity = 1;
        congestionCharge.rateAmount = Number(congestionRate.rateAmount) || 0;
        congestionCharge.amount = Number(congestionRate.rateAmount) || 0;
    }
    const shouldRecompute = ["approved_area_assigned", "gate_in_approved", "stored_in_assigned_area", "gate_out_requested", "gate_out_approved", "gate_out_reversal_requested"].includes(booking.status);
    const billingResult = shouldRecompute ? await (0, exports.computeBookingBilling)(booking, { persist: true }) : null;
    const rateTypeLabel = requestedRateType === "international" ? "International" : "Local";
    const previousRateTypeLabel = previousRateType === "international" ? "International" : "Local";
    const classificationChanged = previousRateType !== requestedRateType;
    addHistory(booking, {
        remarks: billingResult
            ? `${classificationChanged ? `Rate classification changed from ${previousRateTypeLabel} to ${rateTypeLabel}` : `${rateTypeLabel} rate classification reconfirmed`}. Billing automatically recalculated to PHP ${billingResult.total.toLocaleString()} using the current ${rateTypeLabel} rates.`
            : `${classificationChanged ? `Rate classification changed from ${previousRateTypeLabel} to ${rateTypeLabel}` : `${rateTypeLabel} rate classification reconfirmed`}. Billing will automatically use ${rateTypeLabel} rates once the container reaches the billable workflow.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:billing_operation_updated", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:billing_operation_updated", payload);
    await notifyClient(
        booking,
        "Booking rate classification updated",
        billingResult
            ? `Your booking classification is now ${rateTypeLabel}. Billing has been automatically recalculated using the current ${rateTypeLabel} rates.`
            : `Your booking classification is now ${rateTypeLabel}. The matching ${rateTypeLabel} rates will be used automatically when billing is computed.`,
        [
            { label: "Classification", value: rateTypeLabel },
            { label: "Billing Total", value: billingResult ? `PHP ${billingResult.total.toLocaleString()}` : "Pending billable workflow" },
        ],
    );
    return res.json({
        success: true,
        message: billingResult
            ? `${rateTypeLabel} classification saved. Billing recalculated to PHP ${billingResult.total.toLocaleString()}.`
            : `${rateTypeLabel} classification saved. Billing will use the matching rates automatically.`,
        booking: payload,
    });
};
exports.updateBookingRateClassification = updateBookingRateClassification;
exports.updateBookingBillingOperation = updateBookingRateClassification;
const getBookingCongestionSurchargeOption = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found." });
    const option = await resolveCongestionSurchargeOption(booking);
    return res.json({ success: true, option });
};
exports.getBookingCongestionSurchargeOption = getBookingCongestionSurchargeOption;
const addBookingCongestionSurcharge = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found." });
    if (!["unpaid", "payment_rejected"].includes(booking.billingStatus)) {
        return res.status(400).json({ success: false, message: "Congestion Surcharge can only be added before payment is submitted or after a rejected payment." });
    }
    await booking.populate("assignedArea", "name code isCongestionArea");
    if (!booking.assignedArea?.isCongestionArea) {
        return res.status(400).json({ success: false, message: "Congestion surcharge is applied during pre-advice assignment to a designated congestion area." });
    }
    const option = await resolveCongestionSurchargeOption(booking, { requireCongestionSpace: false });
    if (!option.available || !option.rate) {
        return res.status(400).json({ success: false, message: option.reason || "Congestion Surcharge is not available." });
    }
    const alreadyAdded = (booking.additionalBillingCharges || []).some((item) => String(item.chargeCode || "") === option.rate.chargeCode);
    if (alreadyAdded) {
        return res.status(409).json({ success: false, message: "Congestion Surcharge has already been added to this booking." });
    }
    booking.additionalBillingCharges.push({
        rate: option.rate.id,
        chargeCode: option.rate.chargeCode,
        source: "congestion_surcharge",
        description: option.rate.description || "Congestion Surcharge",
        quantity: 1,
        rateAmount: option.rate.rateAmount,
        amount: option.rate.rateAmount,
        notes: "Applied because the container is assigned to the designated congestion area.",
        addedBy: req.user._id,
        addedAt: new Date(),
    });
    const canCompute = ["approved_area_assigned", "gate_in_approved", "stored_in_assigned_area", "gate_out_requested", "gate_out_approved", "gate_out_reversal_requested"].includes(booking.status);
    const billingResult = canCompute ? await (0, exports.computeBookingBilling)(booking, { persist: true }) : null;
    addHistory(booking, {
        remarks: billingResult
            ? `Congestion Surcharge added. Bill recomputed at PHP ${billingResult.total.toLocaleString()}.`
            : "Congestion Surcharge added because the yard had no available space.",
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:congestion_surcharge_added", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:congestion_surcharge_added", payload);
    await (0, notificationService_js_1.createClientNotification)({
        recipient: booking.client?._id || booking.client,
        type: "billing_charge_added",
        title: "Congestion surcharge added",
        message: billingResult
            ? `A congestion surcharge was added. Your updated bill is PHP ${billingResult.total.toLocaleString()}.`
            : "A congestion surcharge was added and will be included when your final bill is computed.",
        booking: booking._id,
        bookingReference: booking.bookingReference || booking.bookingNumber || "",
        containerNumber: booking.containerNumber || "",
        actionPath: "/booking-history",
    });
    return res.status(201).json({ success: true, message: "Congestion Surcharge added.", booking: payload });
};
exports.addBookingCongestionSurcharge = addBookingCongestionSurcharge;
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
    if (/congestion/i.test(description)) {
        return res.status(400).json({ success: false, message: "Use the Congestion Surcharge option. It is available only when the yard has no remaining space." });
    }
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
    const canCompute = ["approved_area_assigned", "gate_in_approved", "stored_in_assigned_area", "gate_out_requested", "gate_out_approved", "gate_out_reversal_requested"].includes(booking.status);
    const billingResult = canCompute ? await (0, exports.computeBookingBilling)(booking, { persist: true }) : null;
    addHistory(booking, {
        remarks: billingResult
            ? `Additional billing charge added: ${description}. Bill recomputed at PHP ${billingResult.total.toLocaleString()}.`
            : `Additional billing charge added: ${description}. It will be included when final billing is computed.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:additional_charge_added", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:additional_charge_added", payload);
    await (0, notificationService_js_1.createClientNotification)({
        recipient: booking.client?._id || booking.client,
        type: "billing_charge_added",
        title: "Additional billing item added",
        message: billingResult
            ? `${description} was added to your bill. Updated total: PHP ${billingResult.total.toLocaleString()}.`
            : `${description} was added and will be included when your final bill is computed.`,
        booking: booking._id,
        bookingReference: booking.bookingReference || booking.bookingNumber || "",
        containerNumber: booking.containerNumber || "",
        actionPath: "/booking-history",
    });
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
    if (charge.source === "congestion_surcharge") {
        return res.status(400).json({
            success: false,
            message: "The congestion surcharge is controlled by the Pre-Advice yard assignment. Reassign the booking to a regular yard area to remove it.",
        });
    }
    const description = charge.description;
    charge.deleteOne();
    const billingResult = ["approved_area_assigned", "gate_in_approved", "stored_in_assigned_area", "gate_out_requested", "gate_out_approved", "gate_out_reversal_requested"].includes(booking.status) ? await (0, exports.computeBookingBilling)(booking, { persist: true }) : null;
    addHistory(booking, {
        remarks: billingResult
            ? `Additional billing charge removed: ${description}. Bill recomputed at PHP ${billingResult.total.toLocaleString()}.`
            : `Additional billing charge removed: ${description}.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:additional_charge_deleted", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:additional_charge_deleted", payload);
    await (0, notificationService_js_1.createClientNotification)({
        recipient: booking.client?._id || booking.client,
        type: "billing_charge_removed",
        title: "Additional billing item removed",
        message: billingResult
            ? `${description} was removed from your bill. Updated total: PHP ${billingResult.total.toLocaleString()}.`
            : `${description} was removed from your pending billing items.`,
        booking: booking._id,
        bookingReference: booking.bookingReference || booking.bookingNumber || "",
        containerNumber: booking.containerNumber || "",
        actionPath: "/booking-history",
    });
    return res.json({ success: true, message: "Additional billing charge removed.", booking: payload });
};
exports.deleteBookingAdditionalCharge = deleteBookingAdditionalCharge;
const submitBookingPayment = async (req, res) => {
    const booking = await Booking_js_1.default.findOne({ _id: req.params.id, client: req.user._id });
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    const isGateInPayment = booking.status === "approved_area_assigned" && getLoloPaymentStage(booking) === "gate_in";
    const isGateOutPayment = ["gate_out_requested", "gate_out_approved"].includes(booking.status) && Boolean(booking.outDate);
    if (!isGateInPayment && !isGateOutPayment) {
        return res.status(400).json({ success: false, message: getLoloPaymentStage(booking) === "gate_out" && booking.status === "approved_area_assigned" ? "LOLO payment is configured for Gate-Out for this booking. No payment is required at Gate-In." : "Payment is available for Gate-In LOLO when configured for Gate-In, or for the remaining Gate-Out balance after Date Out is submitted." });
    }
    if (["payment_submitted", "payment_under_review"].includes(booking.billingStatus)) {
        return res.status(409).json({ success: false, message: "A payment is already under review for this booking." });
    }
    const paymentStage = isGateInPayment ? "gate_in" : "gate_out";
    booking.isVatApplicable = ![false, "false", "0", 0, "non_vat"].includes(req.body.isVatApplicable);
    const billingResult = await (0, exports.computeBookingBilling)(booking, {
        asOf: isGateOutPayment ? booking.outDate : new Date(),
        persist: true,
        phase: paymentStage,
    });
    if (!billingResult.hasMatchedRates) {
        return res.status(400).json({ success: false, message: paymentStage === "gate_in"
            ? "No active Lift On / Lift Off rate matched this booking. Please ask admin to complete Rate Setup first."
            : "No active billing rate matched this booking. Please ask admin to complete Rate Setup first." });
    }
    if (billingResult.total <= 0) {
        return res.status(400).json({ success: false, message: "Computed billing amount is zero. Please ask admin to review the rate setup." });
    }
    const creditResult = applyApprovedPaymentCredit(booking, billingResult.total);
    if (creditResult.balanceDue <= 0) {
        booking.billingStatus = "paid_approved";
        await booking.save();
        return res.status(409).json({ success: false, message: "No additional payment is required. The approved payment credit already covers the current bill." });
    }
    const requestedPaymentTypeId = String(req.body.paymentTypeId || "").trim();
    if (!requestedPaymentTypeId) {
        return res.status(400).json({ success: false, message: "Please select an available non-cash payment type." });
    }
    const paymentType = await PaymentType_js_1.default.findOne({
        _id: requestedPaymentTypeId,
        status: "active",
        type: { $in: ["bank", "ewallet"] },
    });
    if (!paymentType) {
        return res.status(400).json({ success: false, message: "Please select an available non-cash payment type." });
    }
    const clientPaymentReference = String(req.body.paymentReferenceNumber || "").trim();
    const paymentProofs = await uploadBookingPaymentDocuments({
        files: req.files,
        bookingReference: booking.bookingReference,
        clientId: req.user._id,
    });
    if (paymentProofs.length === 0) {
        return res.status(400).json({
            success: false,
            message: "Proof of payment is required for all online payments.",
        });
    }
    if (Number(booking.approvedPaymentAmount || 0) > 0 || (booking.paymentTransactions || []).length > 0 || booking.billingStatus === "payment_rejected") {
        clearCurrentPaymentSubmission(booking);
    }
    booking.paymentAmount = creditResult.balanceDue;
    booking.paymentBalanceDue = creditResult.balanceDue;
    booking.paymentType = paymentType._id;
    booking.paymentTypeSnapshot = {
        type: paymentType.type,
        name: paymentType.name,
        bankName: paymentType.bankName || "",
        accountNumber: paymentType.accountNumber,
        accountName: paymentType.accountName,
        qrUrl: paymentType.qrSecureUrl || paymentType.qrUrl || "",
    };
    booking.paymentReferenceNumber = String(clientPaymentReference || await buildPaymentReferenceNumber()).trim();
    booking.paymentDate = new Date();
    booking.paymentRemarks = req.body.paymentRemarks || "";
    booking.paymentProofs = paymentProofs;
    booking.paymentSubmittedAt = new Date();
    booking.paymentRejectionReason = "";
    booking.billingStatus = "payment_under_review";
    const stageLabel = paymentStage === "gate_in" ? "Gate-In LOLO" : "Gate-Out balance";
    addHistory(booking, {
        billingStatus: "payment_under_review",
        remarks: `${stageLabel} payment proof submitted by client for PHP ${creditResult.balanceDue.toLocaleString()}. Gross bill PHP ${billingResult.total.toLocaleString()} with PHP ${creditResult.approvedAmount.toLocaleString()} approved payment credit applied.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:payment_submitted", payload);
    (0, socket_js_1.emitToUser)(req.user._id, "booking:payment_submitted", payload);
    await notifyClient(booking, `${stageLabel} payment submitted`, "Your payment proof was submitted and is now under admin review.", [
        { label: "Reference Number", value: booking.paymentReferenceNumber },
        { label: "Amount", value: `PHP ${creditResult.balanceDue.toLocaleString()}` },
    ]);
    await notifyAdmin(booking, `${stageLabel} payment submitted for review`, "A client submitted proof of payment for review.", [
        { label: "Client", value: getClientDisplayName(booking.client) },
        { label: "Reference Number", value: booking.paymentReferenceNumber },
    ]);
    return res.json({ success: true, message: `${stageLabel} payment submitted for admin review.`, booking: payload });
};
exports.submitBookingPayment = submitBookingPayment;
const recordAdminCashPayment = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found." });
    const isGateInPayment = booking.status === "approved_area_assigned" && getLoloPaymentStage(booking) === "gate_in";
    const isGateOutPayment = ["gate_out_requested", "gate_out_approved"].includes(booking.status) && Boolean(booking.outDate);
    if (!isGateInPayment && !isGateOutPayment) {
        return res.status(400).json({ success: false, message: getLoloPaymentStage(booking) === "gate_out" && booking.status === "approved_area_assigned" ? "LOLO payment is configured for Gate-Out for this booking. No cash payment is required at Gate-In." : "Cash payment is available for Gate-In LOLO when configured for Gate-In, or for the remaining Gate-Out balance after Date Out is submitted." });
    }
    if (booking.billingStatus === "paid_approved" && Number(booking.paymentBalanceDue || 0) <= 0) {
        return res.status(409).json({ success: false, message: "This billing stage is already fully paid." });
    }
    if (["payment_submitted", "payment_under_review"].includes(booking.billingStatus)) {
        const existingPaymentType = String(booking.paymentTypeSnapshot?.type || "").trim().toLowerCase();
        if (["bank", "ewallet"].includes(existingPaymentType) || (Array.isArray(booking.paymentProofs) && booking.paymentProofs.length > 0)) {
            return res.status(409).json({ success: false, message: "Cash payment is disabled while an online payment is under review for this booking." });
        }
    }
    const paymentStage = isGateInPayment ? "gate_in" : "gate_out";
    const rawAdditionalItems = Array.isArray(req.body.additionalItems) ? req.body.additionalItems : [];
    if (paymentStage === "gate_in" && rawAdditionalItems.length > 0) {
        return res.status(400).json({ success: false, message: "Gate-In cash payment is limited to Lift On / Lift Off charges. Add storage and other charges during Gate-Out." });
    }
    if (rawAdditionalItems.length > 20) {
        return res.status(400).json({ success: false, message: "A cash payment can include up to 20 additional items." });
    }
    const additionalItems = [];
    for (let index = 0; index < rawAdditionalItems.length; index += 1) {
        const rawItem = rawAdditionalItems[index] || {};
        const description = String(rawItem.description || "").trim();
        const quantity = Number(rawItem.quantity);
        const rateAmount = Number(rawItem.rateAmount);
        if (!description) {
            return res.status(400).json({ success: false, message: `Additional item ${index + 1} requires a description.` });
        }
        if (/congestion/i.test(description)) {
            return res.status(400).json({ success: false, message: "Use the configured Congestion Surcharge option instead of adding it manually." });
        }
        if (!Number.isFinite(quantity) || quantity <= 0) {
            return res.status(400).json({ success: false, message: `Additional item ${index + 1} requires a quantity greater than zero.` });
        }
        if (!Number.isFinite(rateAmount) || rateAmount <= 0) {
            return res.status(400).json({ success: false, message: `Additional item ${index + 1} requires a rate greater than zero.` });
        }
        const normalizedQuantity = Math.round(quantity * 100) / 100;
        const normalizedRateAmount = Math.round(rateAmount * 100) / 100;
        additionalItems.push({
            description,
            quantity: normalizedQuantity,
            rateAmount: normalizedRateAmount,
            amount: Math.round(normalizedQuantity * normalizedRateAmount * 100) / 100,
            notes: String(rawItem.notes || "").trim(),
            source: "manual",
            addedBy: req.user._id,
            addedAt: new Date(),
        });
    }
    if (additionalItems.length > 0) {
        booking.additionalBillingCharges.push(...additionalItems);
    }
    booking.isVatApplicable = ![false, "false", "0", 0, "non_vat"].includes(req.body.isVatApplicable);
    const billingResult = await (0, exports.computeBookingBilling)(booking, {
        asOf: isGateOutPayment ? booking.outDate : new Date(),
        persist: true,
        phase: paymentStage,
    });
    if (!billingResult.hasMatchedRates || billingResult.total <= 0) {
        return res.status(400).json({ success: false, message: paymentStage === "gate_in"
            ? "Configure active Lift On / Lift Off rates before recording Gate-In cash payment."
            : "Complete Rate Setup before recording the cash payment." });
    }
    const creditResult = applyApprovedPaymentCredit(booking, billingResult.total);
    if (creditResult.balanceDue <= 0) {
        booking.billingStatus = "paid_approved";
        await booking.save();
        return res.status(409).json({ success: false, message: "No additional cash payment is required. Existing approved payment credit covers the current bill." });
    }
    const cashQuery = { type: "cash", status: "active" };
    if (req.body.paymentTypeId) cashQuery._id = req.body.paymentTypeId;
    const paymentType = await PaymentType_js_1.default.findOne(cashQuery).sort({ createdAt: 1 });
    if (!paymentType) {
        return res.status(400).json({ success: false, message: "No active Cash payment type is configured." });
    }
    const cashReceived = Number(req.body.cashReceived);
    if (!Number.isFinite(cashReceived) || cashReceived < creditResult.balanceDue) {
        return res.status(400).json({ success: false, message: `Cash received must be at least PHP ${creditResult.balanceDue.toLocaleString()}.` });
    }
    const changeAmount = Math.round((cashReceived - creditResult.balanceDue) * 100) / 100;
    if (Number(booking.approvedPaymentAmount || 0) > 0 || (booking.paymentTransactions || []).length > 0 || booking.billingStatus === "payment_rejected") {
        clearCurrentPaymentSubmission(booking);
    }
    booking.paymentAmount = creditResult.balanceDue;
    booking.paymentBalanceDue = creditResult.balanceDue;
    booking.paymentType = paymentType._id;
    booking.paymentTypeSnapshot = {
        type: "cash",
        name: paymentType.name || "Cash",
        bankName: "",
        accountNumber: "",
        accountName: "",
        qrUrl: "",
    };
    booking.paymentReferenceNumber = String(req.body.paymentReferenceNumber || await buildPaymentReferenceNumber()).trim();
    booking.paymentDate = new Date();
    booking.paymentRemarks = String(req.body.paymentRemarks || req.body.remarks || "Cash received by authorized admin cashier.").trim();
    booking.paymentSubmittedAt = new Date();
    booking.paymentReviewedAt = new Date();
    booking.paymentReviewedBy = req.user._id;
    booking.paymentRejectionReason = "";
    booking.cashReceived = cashReceived;
    booking.changeAmount = changeAmount;
    booking.receiptNumber = await buildReceiptNumber(booking.isVatApplicable);
    booking.receiptType = booking.isVatApplicable ? "official_receipt" : "acknowledgement_receipt";
    booking.receiptGeneratedAt = new Date();
    archiveCurrentApprovedPayment(booking, { approvedBy: req.user._id, source: "cash", amountOverride: creditResult.balanceDue });
    booking.approvedPaymentAmount = roundMoney(creditResult.approvedAmount + creditResult.balanceDue);
    applyApprovedPaymentCredit(booking, billingResult.total);
    booking.billingStatus = "paid_approved";
    const addedItemsHistory = additionalItems.length > 0
        ? ` Added ${additionalItems.length} additional item${additionalItems.length === 1 ? "" : "s"} worth PHP ${additionalItems.reduce((sum, item) => sum + item.amount, 0).toLocaleString()}.`
        : "";
    const stageLabel = paymentStage === "gate_in" ? "Gate-In LOLO" : "Gate-Out";
    addHistory(booking, {
        billingStatus: "paid_approved",
        remarks: `${stageLabel} cash payment recorded.${addedItemsHistory} Received PHP ${cashReceived.toLocaleString()}, change PHP ${changeAmount.toLocaleString()}. Receipt ${booking.receiptNumber}.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:cash_payment_recorded", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:cash_payment_recorded", payload);
    await notifyClient(booking, `${stageLabel} cash payment recorded`, paymentStage === "gate_in"
        ? "Your Lift On / Lift Off cash payment was recorded and approved. The container can proceed to Gate-In inspection."
        : "Your cash payment was recorded and approved. Gate-Out processing can continue.", [
        { label: "Payment Reference", value: booking.paymentReferenceNumber },
        { label: "Amount", value: `PHP ${creditResult.balanceDue.toLocaleString()}` },
        { label: "Total Approved Payment", value: `PHP ${booking.approvedPaymentAmount.toLocaleString()}` },
    ]);
    return res.json({
        success: true,
        message: paymentStage === "gate_in"
            ? "Gate-In LOLO cash payment recorded and receipt generated."
            : "Gate-Out cash payment recorded and receipt generated.",
        booking: payload,
        receipt: { number: booking.receiptNumber, type: booking.receiptType, cashReceived, changeAmount },
    });
};
exports.recordAdminCashPayment = recordAdminCashPayment;
const approveBookingPayment = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (!["payment_submitted", "payment_under_review", "payment_rejected"].includes(booking.billingStatus)) {
        return res.status(400).json({ success: false, message: "Only submitted payments can be approved." });
    }
    const approvedInstallment = roundMoney(Number(booking.paymentAmount) || 0);
    const previousApprovedAmount = getApprovedPaymentAmount({
        approvedPaymentAmount: booking.approvedPaymentAmount,
        billingStatus: "unpaid",
        paymentAmount: 0,
        billingTotal: 0,
    });
    booking.paymentReviewedAt = new Date();
    booking.paymentReviewedBy = req.user._id;
    booking.paymentRejectionReason = "";
    booking.receiptNumber = booking.receiptNumber || await buildReceiptNumber(booking.isVatApplicable);
    booking.receiptType = booking.isVatApplicable ? "official_receipt" : "acknowledgement_receipt";
    booking.receiptGeneratedAt = new Date();
    archiveCurrentApprovedPayment(booking, { approvedBy: req.user._id, source: "online", amountOverride: approvedInstallment });
    booking.approvedPaymentAmount = roundMoney(previousApprovedAmount + approvedInstallment);
    applyApprovedPaymentCredit(booking, booking.billingTotal);
    booking.billingStatus = "paid_approved";
    addHistory(booking, { billingStatus: "paid_approved", remarks: `${req.body.remarks || "Payment approved by admin."} Receipt ${booking.receiptNumber} generated.`, changedBy: req.user._id });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:payment_approved", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:payment_approved", payload);
    const approvedStageLabel = booking.billingStage === "gate_in" ? "Gate-In LOLO" : "Gate-Out";
    await notifyClient(booking, `${approvedStageLabel} payment approved`, booking.billingStage === "gate_in"
        ? "Your Lift On / Lift Off payment has been approved. The container can now proceed to Gate-In inspection."
        : "Your payment has been approved. Admin can now continue the Gate-Out release process.", [
        { label: "Payment Reference", value: booking.paymentReferenceNumber },
    ]);
    return res.json({ success: true, message: `${approvedStageLabel} payment approved.`, booking: payload });
};
exports.approveBookingPayment = approveBookingPayment;
const rejectBookingPayment = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    const reason = req.body.reason || "Payment details were rejected by admin.";
    booking.billingStatus = "payment_rejected";
    booking.paymentReviewedAt = new Date();
    booking.paymentReviewedBy = req.user._id;
    booking.paymentRejectionReason = reason;
    addHistory(booking, { billingStatus: "payment_rejected", remarks: `Payment rejected: ${reason}`, changedBy: req.user._id });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:payment_rejected", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:payment_rejected", payload);
    await notifyClient(booking, "Payment rejected", "Your payment details were rejected. Please submit a corrected reference number or proof of payment.", [
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
    if (["payment_submitted", "payment_under_review"].includes(booking.billingStatus)) {
        return res.status(403).json({ success: false, message: "A payment is still under review. Complete that review before submitting a new Date Out." });
    }
    const gateOutDate = validateGateOutDate(booking, req.body.outDate || req.body.gateOutDate);
    if (!gateOutDate.valid) {
        return res.status(400).json({ success: false, message: gateOutDate.message });
    }
    booking.outDate = gateOutDate.outDate;
    const billingResult = await (0, exports.computeBookingBilling)(booking, { asOf: gateOutDate.outDate, persist: true, phase: "gate_out" });
    if (!billingResult.hasMatchedRates) {
        return res.status(400).json({ success: false, message: "No active billing rate matched this booking. Please ask admin to complete Rate Setup first." });
    }
    if (billingResult.total <= 0) {
        return res.status(400).json({ success: false, message: "Computed billing amount is zero. Please ask admin to review the rate setup." });
    }
    const creditResult = applyApprovedPaymentCredit(booking, billingResult.total);
    booking.billingStatus = creditResult.balanceDue <= 0 ? "paid_approved" : "unpaid";
    booking.status = "gate_out_requested";
    booking.gateOutGracePeriodMinutes = getGateOutGracePeriodMinutes(booking);
    booking.gateOutScheduleStatus = "scheduled";
    booking.gateOutOverstayStartedAt = new Date(gateOutDate.outDate.getTime() + booking.gateOutGracePeriodMinutes * 60 * 1000);
    booking.gateOutRequestedAt = new Date();
    booking.gateOutRequestRemarks = req.body.remarks || "";
    addHistory(booking, {
        remarks: `Gate-out requested by client for ${gateOutDate.outDate.toLocaleString()}. ${getLoloPaymentStage(booking) === "gate_out" ? "LOLO is collected in this Gate-Out bill together with storage and other charges." : "Previously approved Gate-In LOLO payment is applied as credit to the final Gate-Out bill."} Gross bill PHP ${billingResult.total.toLocaleString()}, approved payment credit PHP ${creditResult.approvedAmount.toLocaleString()}, balance due PHP ${creditResult.balanceDue.toLocaleString()}, using ${billingResult.days} calendar billing day${billingResult.days === 1 ? "" : "s"}.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:gate_out_requested", payload);
    (0, socket_js_1.emitToUser)(req.user._id, "booking:gate_out_requested", payload);
    await notifyClient(booking, "Gate-out date submitted", creditResult.balanceDue <= 0
        ? "Your Date Out was submitted. The approved payment credit covers the current final bill."
        : "Your Date Out was submitted and the remaining balance is ready for payment.", [
        { label: "Container", value: booking.containerNumber },
        { label: "Date Out", value: booking.outDate ? booking.outDate.toLocaleString() : "-" },
        { label: "Gross Bill", value: `PHP ${booking.billingTotal.toLocaleString()}` },
        { label: "Approved Payment Credit", value: `PHP ${creditResult.approvedAmount.toLocaleString()}` },
        { label: "Balance Due", value: `PHP ${creditResult.balanceDue.toLocaleString()}` },
    ]);
    await notifyAdmin(booking, "Gate-out requested", "A client has submitted Date Out and requested gate-out release.", [
        { label: "Client", value: getClientDisplayName(booking.client) },
        { label: "Container", value: booking.containerNumber },
        { label: "Date Out", value: booking.outDate ? booking.outDate.toLocaleString() : "-" },
    ]);
    return res.json({
        success: true,
        message: creditResult.balanceDue <= 0
            ? "Gate-out request submitted. Existing approved payment credit covers the final bill."
            : "Gate-out request submitted. Final billing is ready for the remaining payment.",
        booking: payload,
    });
};
exports.requestBookingGateOut = requestBookingGateOut;
const cancelBooking = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found." });
    const cancellableStatuses = ["pending_admin_approval", "approved_area_assigned", "gate_in_approved"];
    if (!cancellableStatuses.includes(booking.status)) {
        return res.status(400).json({ success: false, message: "Only Pre-Advice and Gate-In records can be cancelled before storage or gate-out processing begins." });
    }
    const previousBlockId = booking.assignedBlock ? String(booking.assignedBlock) : "";
    const reason = String(req.body.reason || "Cancelled by admin.").trim();
    booking.status = "cancelled";
    booking.rejectionReason = reason;
    addHistory(booking, { status: "cancelled", remarks: reason, changedBy: req.user._id });
    await booking.save();
    if (previousBlockId) await recalculateBlockOccupancy(previousBlockId);
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:cancelled", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:cancelled", payload);
    return res.json({ success: true, message: "Booking cancelled.", booking: payload });
};
exports.cancelBooking = cancelBooking;
const rejectBookingGateOut = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (booking.status !== "gate_out_requested") {
        return res.status(400).json({ success: false, message: "Only pending gate-out requests can be rejected." });
    }
    const reason = String(req.body.reason || "").trim();
    if (!reason) {
        return res.status(400).json({ success: false, message: "A gate-out rejection reason is required." });
    }
    booking.gateOutRejectedAt = new Date();
    booking.gateOutRejectedBy = req.user._id;
    booking.gateOutRejectionReason = reason;
    addHistory(booking, { remarks: `Gate-out request rejected by admin: ${reason}`, changedBy: req.user._id });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:gate_out_rejected", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:gate_out_rejected", payload);
    await notifyClient(booking, "Gate-out request rejected", "Your gate-out request requires correction or additional coordination before release approval.", [
        { label: "Container", value: booking.containerNumber },
        { label: "Reason", value: reason },
    ]);
    return res.json({ success: true, message: "Gate-out request rejected.", booking: payload });
};
exports.rejectBookingGateOut = rejectBookingGateOut;
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
    booking.gateOutRejectedAt = null;
    booking.gateOutRejectedBy = null;
    booking.gateOutRejectionReason = "";
    booking.gateOutApprovedAt = new Date();
    booking.gateOutApprovedBy = req.user._id;
    booking.gateOutGracePeriodMinutes = getGateOutGracePeriodMinutes(booking);
    const approvalSchedule = getGateOutScheduleInfo(booking, booking.gateOutApprovedAt);
    booking.gateOutScheduleStatus = approvalSchedule.status;
    booking.gateOutOverstayStartedAt = approvalSchedule.overstayStartedAt;
    booking.gateOutPassNumber = booking.gateOutPassNumber || buildGatePassNumber("GOUT", booking.bookingReference, booking._id);
    booking.gateOutRemarks = req.body.remarks || "";
    addHistory(booking, { remarks: `Gate-out approved by admin under pass ${booking.gateOutPassNumber}.`, changedBy: req.user._id });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    await booking.populate("gateOutApprovedBy", "name");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:gate_out_approved", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:gate_out_approved", payload);
    await notifyClient(booking, "Gate-out approved", "Your container is approved for release from the yard.", [
        { label: "Gate-Out Pass No.", value: booking.gateOutPassNumber },
        { label: "Container", value: booking.containerNumber },
        { label: "Assigned Slot", value: booking.assignedSlotNumber },
    ]);
    return res.json({ success: true, message: "Gate-out approved.", booking: payload });
};
exports.approveBookingGateOut = approveBookingGateOut;
const requestGateOutReversal = async (req, res) => {
    const booking = await Booking_js_1.default.findOne({ _id: req.params.id, client: req.user._id });
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (booking.status !== "gate_out_approved" || booking.releasedAt) {
        return res.status(400).json({ success: false, message: "A reversal can only be requested while the approved container is still inside the yard and waiting for release." });
    }
    if (getApprovedPaymentAmount(booking) <= 0) {
        return res.status(403).json({ success: false, message: "A Gate-Out reversal requires at least one approved payment for this booking." });
    }
    const reason = String(req.body.reason || "").trim();
    if (!reason) {
        return res.status(400).json({ success: false, message: "Please explain why the Gate-Out request must be reversed." });
    }
    if (reason.length > 500) {
        return res.status(400).json({ success: false, message: "The reversal reason must not exceed 500 characters." });
    }
    booking.status = "gate_out_reversal_requested";
    booking.gateOutReversalRequestedAt = new Date();
    booking.gateOutReversalRequestedBy = req.user._id;
    booking.gateOutReversalRequestReason = reason;
    booking.gateOutReversalReviewedAt = null;
    booking.gateOutReversalReviewedBy = null;
    booking.gateOutReversalDecision = "";
    booking.gateOutReversalAdminRemarks = "";
    addHistory(booking, {
        status: "gate_out_reversal_requested",
        remarks: `Client requested Gate-Out reversal: ${reason}`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:gate_out_reversal_requested", payload);
    (0, socket_js_1.emitToUser)(req.user._id, "booking:gate_out_reversal_requested", payload);
    await notifyClient(booking, "Gate-Out reversal requested", "Your reversal request was submitted for admin review. The container remains blocked from release while the request is pending.", [
        { label: "Container", value: booking.containerNumber },
        { label: "Reason", value: reason },
    ], { notificationType: "gate_out_reversal_requested" });
    await notifyAdmin(booking, "Gate-Out reversal requested", "A client requested that an approved Gate-Out be returned to storage.", [
        { label: "Client", value: getClientDisplayName(booking.client) },
        { label: "Container", value: booking.containerNumber },
        { label: "Reason", value: reason },
    ]);
    return res.json({ success: true, message: "Gate-Out reversal request submitted for admin review.", booking: payload });
};
exports.requestGateOutReversal = requestGateOutReversal;
const approveGateOutReversal = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (booking.status !== "gate_out_reversal_requested" || booking.releasedAt) {
        return res.status(400).json({ success: false, message: "Only a pending reversal request for a container still inside the yard can be approved." });
    }
    const approvedAmount = getApprovedPaymentAmount(booking);
    archiveCurrentApprovedPayment(booking, {
        approvedBy: booking.paymentReviewedBy || req.user._id,
        source: String(booking.paymentTypeSnapshot?.type || "").toLowerCase() === "cash" ? "cash" : "legacy",
    });
    booking.approvedPaymentAmount = approvedAmount;
    clearCurrentPaymentSubmission(booking);
    booking.outDate = null;
    booking.status = "stored_in_assigned_area";
    booking.gateOutRequestedAt = null;
    booking.gateOutRequestRemarks = "";
    booking.gateOutRejectedAt = null;
    booking.gateOutRejectedBy = null;
    booking.gateOutRejectionReason = "";
    booking.gateOutApprovedAt = null;
    booking.gateOutApprovedBy = null;
    booking.gateOutScheduleStatus = "cancelled";
    booking.gateOutOverstayStartedAt = null;
    booking.gateOutRemarks = "";
    booking.gateOutReversalReviewedAt = new Date();
    booking.gateOutReversalReviewedBy = req.user._id;
    booking.gateOutReversalDecision = "approved";
    booking.gateOutReversalAdminRemarks = String(req.body.remarks || "").trim().slice(0, 500);
    booking.gateOutReversalCount = Number(booking.gateOutReversalCount || 0) + 1;
    const billingResult = await (0, exports.computeBookingBilling)(booking, { asOf: new Date(), persist: true });
    const creditResult = applyApprovedPaymentCredit(booking, billingResult.total);
    booking.billingStatus = creditResult.balanceDue <= 0 ? "paid_approved" : "unpaid";
    addHistory(booking, {
        status: "stored_in_assigned_area",
        billingStatus: booking.billingStatus,
        remarks: `Gate-Out reversal approved. Container returned to storage. Approved payment credit PHP ${creditResult.approvedAmount.toLocaleString()} preserved; current gross bill PHP ${billingResult.total.toLocaleString()}; balance due PHP ${creditResult.balanceDue.toLocaleString()}.${booking.gateOutReversalAdminRemarks ? ` Admin remarks: ${booking.gateOutReversalAdminRemarks}` : ""}`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:gate_out_reversal_approved", payload);
    (0, socket_js_1.emitToAdmins)("storage:updated", payload);
    (0, socket_js_1.emitToAdmins)("inventory:updated", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:gate_out_reversal_approved", payload);
    await notifyClient(booking, "Gate-Out reversal approved", "The incorrect Gate-Out was cancelled and your container was returned to storage. Storage billing has resumed and the approved payment remains available as credit for this booking.", [
        { label: "Container", value: booking.containerNumber },
        { label: "Approved Payment Credit", value: `PHP ${creditResult.approvedAmount.toLocaleString()}` },
        { label: "Current Balance Due", value: `PHP ${creditResult.balanceDue.toLocaleString()}` },
        { label: "Assigned Slot", value: booking.assignedSlotNumber || "Retained" },
    ], { notificationType: "gate_out_reversal_approved" });
    return res.json({ success: true, message: "Gate-Out reversed. Container returned to storage and approved payment preserved as credit.", booking: payload });
};
exports.approveGateOutReversal = approveGateOutReversal;
const rejectGateOutReversal = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (booking.status !== "gate_out_reversal_requested" || booking.releasedAt) {
        return res.status(400).json({ success: false, message: "Only a pending Gate-Out reversal request can be rejected." });
    }
    const reason = String(req.body.reason || "").trim();
    if (!reason) {
        return res.status(400).json({ success: false, message: "A rejection reason is required." });
    }
    if (reason.length > 500) {
        return res.status(400).json({ success: false, message: "The rejection reason must not exceed 500 characters." });
    }
    booking.status = "gate_out_approved";
    booking.gateOutReversalReviewedAt = new Date();
    booking.gateOutReversalReviewedBy = req.user._id;
    booking.gateOutReversalDecision = "rejected";
    booking.gateOutReversalAdminRemarks = reason;
    addHistory(booking, {
        status: "gate_out_approved",
        remarks: `Gate-Out reversal request rejected by admin: ${reason}`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:gate_out_reversal_rejected", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:gate_out_reversal_rejected", payload);
    await notifyClient(booking, "Gate-Out reversal rejected", "The reversal request was rejected. The container remains approved and ready for release.", [
        { label: "Container", value: booking.containerNumber },
        { label: "Reason", value: reason },
    ], { notificationType: "gate_out_reversal_rejected" });
    return res.json({ success: true, message: "Gate-Out reversal request rejected.", booking: payload });
};
exports.rejectGateOutReversal = rejectGateOutReversal;
const updateGateOutRequestDates = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (!["gate_out_requested", "gate_out_approved", "gate_out_reversal_requested"].includes(booking.status) || booking.releasedAt) {
        return res.status(400).json({ success: false, message: "Gate-In / Gate-Out date correction is available only while the Gate-Out request is still active." });
    }
    if (["payment_submitted", "payment_under_review"].includes(booking.billingStatus)) {
        return res.status(409).json({ success: false, message: "Finish the current payment review before correcting Gate-In or Gate-Out dates so the payment amount cannot change during review." });
    }
    const parsedIn = parseBookingDate(req.body.inDate);
    const parsedOut = parseBookingDate(req.body.outDate);
    if (!parsedIn || !parsedOut) {
        return res.status(400).json({ success: false, message: "A valid Gate-In date/time and Gate-Out date/time are required." });
    }
    if (parsedIn.getMinutes() !== 0 || parsedIn.getSeconds() !== 0 || parsedIn.getMilliseconds() !== 0 ||
        parsedOut.getMinutes() !== 0 || parsedOut.getSeconds() !== 0 || parsedOut.getMilliseconds() !== 0) {
        return res.status(400).json({ success: false, message: "Gate-In and Gate-Out times must use whole-hour intervals." });
    }
    if (parsedOut.getTime() <= parsedIn.getTime()) {
        return res.status(400).json({ success: false, message: "Gate-Out must be later than Gate-In." });
    }
    try {
        await ensureBookingHourCapacity(parsedIn, booking._id);
    }
    catch (error) {
        return handleValidationError(error, res);
    }
    const oldInDate = booking.inDate || booking.expectedArrivalDate || booking.gateInApprovedAt;
    const oldOutDate = booking.outDate;
    const previousTotal = roundMoney(booking.billingTotal);
    booking.inDate = parsedIn;
    booking.expectedArrivalDate = parsedIn;
    if (booking.gateInApprovedAt)
        booking.gateInApprovedAt = parsedIn;
    if (booking.storageStartDate || ["stored_in_assigned_area", "gate_out_requested", "gate_out_approved", "gate_out_reversal_requested"].includes(booking.status))
        booking.storageStartDate = parsedIn;
    booking.outDate = parsedOut;
    booking.gateOutGracePeriodMinutes = getGateOutGracePeriodMinutes(booking);
    const schedule = getGateOutScheduleInfo(booking, new Date());
    booking.gateOutScheduleStatus = schedule.status;
    booking.gateOutOverstayStartedAt = schedule.overstayStartedAt;
    const billingResult = await (0, exports.computeBookingBilling)(booking, { asOf: parsedOut, persist: true, phase: "gate_out" });
    if (!billingResult.hasMatchedRates || billingResult.total <= 0) {
        return res.status(400).json({ success: false, message: "No active billing rate matched the corrected dates. Review Rate Setup before saving." });
    }
    const creditResult = applyApprovedPaymentCredit(booking, billingResult.total);
    booking.billingPreviousTotal = previousTotal;
    booking.billingRecomputedAt = new Date();
    booking.billingRecomputedBy = req.user._id;
    booking.billingRecomputeReason = "Super Admin Gate-In / Gate-Out date correction";
    booking.billingRecomputeCount = Number(booking.billingRecomputeCount || 0) + 1;
    booking.billingStatus = creditResult.balanceDue <= 0
        ? "paid_approved"
        : creditResult.approvedAmount > 0
            ? "additional_payment_required"
            : "unpaid";
    addHistory(booking, {
        billingStatus: booking.billingStatus,
        remarks: `Super Admin corrected Gate-In from ${oldInDate ? new Date(oldInDate).toLocaleString() : "-"} to ${parsedIn.toLocaleString()} and Gate-Out from ${oldOutDate ? new Date(oldOutDate).toLocaleString() : "-"} to ${parsedOut.toLocaleString()}. Billing changed from PHP ${previousTotal.toLocaleString()} to PHP ${billingResult.total.toLocaleString()}; balance due PHP ${creditResult.balanceDue.toLocaleString()}.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    await booking.populate("billingRecomputedBy", "name");
    await booking.populate("overstayFeeWaivedBy", "name");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:gate_out_dates_updated", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:gate_out_dates_updated", payload);
    await notifyClient(booking, "Gate-In / Gate-Out schedule corrected", "A Super Admin corrected the Gate-In and Gate-Out dates for your active Gate-Out request. Billing has been recalculated using the corrected dates.", [
        { label: "Gate-In", value: parsedIn.toLocaleString() },
        { label: "Gate-Out", value: parsedOut.toLocaleString() },
        { label: "Balance Due", value: `PHP ${creditResult.balanceDue.toLocaleString()}` },
    ]);
    return res.json({ success: true, message: "Gate-In and Gate-Out dates updated. Billing was recalculated.", booking: payload });
};
exports.updateGateOutRequestDates = updateGateOutRequestDates;
const setBookingOverstayFeePolicy = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (!["gate_out_approved", "gate_out_reversal_requested"].includes(booking.status) || booking.releasedAt) {
        return res.status(400).json({ success: false, message: "Overstay fee policy can only be changed for an approved Gate-Out container still inside the yard." });
    }
    if (["payment_submitted", "payment_under_review"].includes(booking.billingStatus)) {
        return res.status(409).json({ success: false, message: "Finish the current supplemental payment review before changing the overstay fee policy." });
    }
    const waive = [true, "true", "1", 1, "waive", "waived"].includes(req.body.waive);
    const reason = String(req.body.reason || "").trim();
    if (waive && !reason) {
        return res.status(400).json({ success: false, message: "Enter a reason when waiving the overstay fee." });
    }
    const serverTime = new Date();
    const previousTotal = roundMoney(booking.billingTotal);
    booking.overstayFeeWaived = waive;
    booking.overstayFeeWaivedAt = waive ? new Date() : null;
    booking.overstayFeeWaivedBy = waive ? req.user._id : null;
    booking.overstayFeeWaiverReason = waive ? reason : "";
    const schedule = getGateOutScheduleInfo(booking, serverTime);
    const billingAsOf = waive && booking.outDate
        ? parseBookingDate(booking.outDate) || serverTime
        : schedule.isOverstaying
            ? serverTime
            : parseBookingDate(booking.outDate) || serverTime;
    const billingResult = await (0, exports.computeBookingBilling)(booking, {
        asOf: billingAsOf,
        persist: true,
        useAsOfAsBillingEnd: !waive && schedule.isOverstaying,
        phase: "gate_out",
    });
    const creditResult = applyApprovedPaymentCredit(booking, billingResult.total);
    booking.billingPreviousTotal = previousTotal;
    booking.billingRecomputedAt = serverTime;
    booking.billingRecomputedBy = req.user._id;
    booking.billingRecomputeReason = waive ? "Super Admin waived overstay fee" : "Super Admin enabled overstay fee";
    booking.billingRecomputeCount = Number(booking.billingRecomputeCount || 0) + 1;
    booking.gateOutScheduleStatus = schedule.status;
    booking.gateOutOverstayStartedAt = schedule.overstayStartedAt;
    booking.billingStatus = creditResult.balanceDue <= 0
        ? "paid_approved"
        : creditResult.approvedAmount > 0
            ? "additional_payment_required"
            : "unpaid";
    addHistory(booking, {
        billingStatus: booking.billingStatus,
        remarks: waive
            ? `Super Admin waived overstay charges. Billing remains capped at the scheduled Gate-Out time. Reason: ${reason}. Gross bill PHP ${billingResult.total.toLocaleString()}, balance due PHP ${creditResult.balanceDue.toLocaleString()}.`
            : `Super Admin enabled overstay charges. Billing was recomputed using ${schedule.isOverstaying ? "current server time" : "the scheduled Gate-Out time"}. Gross bill PHP ${billingResult.total.toLocaleString()}, balance due PHP ${creditResult.balanceDue.toLocaleString()}.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    await booking.populate("billingRecomputedBy", "name");
    await booking.populate("overstayFeeWaivedBy", "name");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:overstay_fee_policy_updated", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:overstay_fee_policy_updated", payload);
    await notifyClient(booking, waive ? "Overstay fee waived" : "Overstay fee policy updated", waive
        ? "A Super Admin waived the overstay fee for this Gate-Out. Billing will remain based on the scheduled Gate-Out time."
        : "Overstay charging is active for this Gate-Out and billing may continue until physical release.", [
        { label: "Container", value: booking.containerNumber },
        { label: "Current Gross Bill", value: `PHP ${billingResult.total.toLocaleString()}` },
        { label: "Balance Due", value: `PHP ${creditResult.balanceDue.toLocaleString()}` },
    ]);
    return res.json({ success: true, message: waive ? "Overstay fee waived and billing capped at scheduled Gate-Out." : "Overstay fee enabled and billing refreshed.", booking: payload, preview: await buildGateOutBillingPreview(booking, serverTime) });
};
exports.setBookingOverstayFeePolicy = setBookingOverstayFeePolicy;
const buildGateOutBillingPreview = async (booking, asOf = new Date()) => {
    const serverTime = parseBookingDate(asOf) || new Date();
    const schedule = getGateOutScheduleInfo(booking, serverTime);
    const billingAsOf = booking.overstayFeeWaived && booking.outDate
        ? parseBookingDate(booking.outDate) || serverTime
        : serverTime;
    const billingResult = await (0, exports.computeBookingBilling)(booking, {
        asOf: billingAsOf,
        persist: false,
        useAsOfAsBillingEnd: !booking.overstayFeeWaived,
        phase: "gate_out",
    });
    const approvedAmount = getApprovedPaymentAmount(booking);
    const balanceDue = roundMoney(Math.max(billingResult.total - approvedAmount, 0));
    const approvedCreditBalance = roundMoney(Math.max(approvedAmount - billingResult.total, 0));
    const previousTotal = roundMoney(booking.billingTotal);
    return {
        serverTime,
        billingAsOf,
        scheduledGateOutAt: schedule.scheduledAt,
        gracePeriodMinutes: schedule.gracePeriodMinutes,
        overstayStartedAt: schedule.overstayStartedAt,
        overstayDurationMinutes: schedule.overstayDurationMinutes,
        gateOutScheduleStatus: schedule.status,
        isOverstaying: schedule.isOverstaying,
        overstayFeeWaived: Boolean(booking.overstayFeeWaived),
        overstayFeeWaiverReason: booking.overstayFeeWaiverReason || "",
        previousTotal,
        recomputedTotal: roundMoney(billingResult.total),
        additionalAmount: roundMoney(Math.max(billingResult.total - previousTotal, 0)),
        billingDays: billingResult.days,
        billingSubtotal: billingResult.subtotal,
        vatAmount: billingResult.vatAmount,
        approvedPaymentCredit: approvedAmount,
        approvedCreditBalance,
        balanceDue,
        lineItems: billingResult.lineItems,
        hasMatchedRates: billingResult.hasMatchedRates,
    };
};
const previewGateOutBilling = async (req, res) => {
    const booking = await populateBooking(Booking_js_1.default.findById(req.params.id));
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (!["gate_out_approved", "gate_out_reversal_requested"].includes(booking.status) || booking.releasedAt) {
        return res.status(400).json({ success: false, message: "Billing preview is available only for an approved Gate-Out container that is still inside the yard." });
    }
    const preview = await buildGateOutBillingPreview(booking, new Date());
    return res.json({
        success: true,
        message: preview.overstayFeeWaived
            ? "Overstay fee is waived. Billing remains capped at the scheduled Gate-Out time."
            : preview.isOverstaying
                ? "Overstay billing preview computed using the current server time."
                : "The container is still within its approved release window.",
        preview,
        booking: safeBooking(booking),
    });
};
exports.previewGateOutBilling = previewGateOutBilling;
const recomputeGateOutBilling = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (!["gate_out_approved", "gate_out_reversal_requested"].includes(booking.status) || booking.releasedAt) {
        return res.status(400).json({ success: false, message: "Billing can be recomputed only for an approved Gate-Out container that is still inside the yard." });
    }
    if (["payment_submitted", "payment_under_review"].includes(booking.billingStatus)) {
        return res.status(409).json({ success: false, message: "A supplemental payment is already under review. Complete that review before recomputing billing again." });
    }
    if (booking.overstayFeeWaived) {
        return res.status(409).json({ success: false, message: "Overstay fee is waived by Super Admin. Billing is capped at the scheduled Gate-Out time and cannot be recomputed as an overstay charge." });
    }
    const serverTime = new Date();
    const preview = await buildGateOutBillingPreview(booking, serverTime);
    if (!preview.isOverstaying) {
        return res.status(400).json({ success: false, message: "This container is not yet overstaying. Billing remains based on the approved scheduled Gate-Out time." });
    }
    if (!preview.hasMatchedRates || preview.recomputedTotal <= 0) {
        return res.status(400).json({ success: false, message: "No active billing rate matched this booking. Review Rate Setup before recomputing the bill." });
    }
    const previousTotal = roundMoney(booking.billingTotal);
    const billingResult = await (0, exports.computeBookingBilling)(booking, { asOf: serverTime, persist: true, useAsOfAsBillingEnd: true, phase: "gate_out" });
    const creditResult = applyApprovedPaymentCredit(booking, billingResult.total);
    booking.billingPreviousTotal = previousTotal;
    booking.billingRecomputedAt = serverTime;
    booking.billingRecomputedBy = req.user._id;
    booking.billingRecomputeReason = "Gate-Out overstay";
    booking.billingRecomputeCount = Number(booking.billingRecomputeCount || 0) + 1;
    booking.gateOutScheduleStatus = "overstaying";
    booking.gateOutOverstayStartedAt = preview.overstayStartedAt;
    booking.billingStatus = creditResult.balanceDue > 0 ? "additional_payment_required" : "paid_approved";
    addHistory(booking, {
        billingStatus: booking.billingStatus,
        remarks: `Overstay billing recomputed using server time ${serverTime.toLocaleString()}. Previous gross bill PHP ${previousTotal.toLocaleString()}, recomputed gross bill PHP ${billingResult.total.toLocaleString()}, approved payment credit PHP ${creditResult.approvedAmount.toLocaleString()}, balance due PHP ${creditResult.balanceDue.toLocaleString()}.`,
        changedBy: req.user._id,
    });
    await booking.save();
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    await booking.populate("billingRecomputedBy", "name");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:overstay_billing_recomputed", payload);
    (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:overstay_billing_recomputed", payload);
    await notifyClient(booking, "Overstay billing updated", creditResult.balanceDue > 0
        ? "Your container remained in the yard beyond the approved Gate-Out schedule. A supplemental balance is now required before physical release."
        : "Your container remained in the yard beyond the approved Gate-Out schedule. The updated bill is fully covered by your approved payment credit.", [
        { label: "Container", value: booking.containerNumber },
        { label: "Recomputed As Of", value: serverTime.toLocaleString() },
        { label: "Updated Gross Bill", value: `PHP ${billingResult.total.toLocaleString()}` },
        { label: "Approved Payment Credit", value: `PHP ${creditResult.approvedAmount.toLocaleString()}` },
        { label: "Additional Balance Due", value: `PHP ${creditResult.balanceDue.toLocaleString()}` },
    ], { notificationType: "overstay_billing_recomputed" });
    return res.json({
        success: true,
        message: creditResult.balanceDue > 0
            ? `Overstay billing recomputed. An additional PHP ${creditResult.balanceDue.toLocaleString()} must be paid and approved before release.`
            : "Overstay billing recomputed. Approved payment credit still covers the updated total.",
        booking: payload,
        preview: await buildGateOutBillingPreview(booking, serverTime),
    });
};
exports.recomputeGateOutBilling = recomputeGateOutBilling;
const completeBookingGateOut = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking)
        return res.status(404).json({ success: false, message: "Booking not found." });
    if (!["gate_out_approved", "completed_gate_out_done"].includes(booking.status)) {
        return res.status(400).json({ success: false, message: "Only approved gate-out bookings can be completed." });
    }
    if (booking.status === "gate_out_approved") {
        const actualReleaseTime = new Date();
        const finalBillingAsOf = booking.overstayFeeWaived && booking.outDate
            ? parseBookingDate(booking.outDate) || actualReleaseTime
            : actualReleaseTime;
        const previousTotal = roundMoney(booking.billingTotal);
        const releaseBilling = await (0, exports.computeBookingBilling)(booking, {
            asOf: finalBillingAsOf,
            persist: true,
            useAsOfAsBillingEnd: !booking.overstayFeeWaived,
            phase: "gate_out",
        });
        const releaseCredit = applyApprovedPaymentCredit(booking, releaseBilling.total);
        const finalBillingBasisLabel = booking.overstayFeeWaived
            ? "the scheduled Gate-Out time because the overstay fee is waived"
            : "the actual server release time";
        booking.billingPreviousTotal = previousTotal;
        booking.billingRecomputedAt = finalBillingAsOf;
        booking.billingRecomputedBy = req.user._id;
        booking.billingRecomputeReason = booking.overstayFeeWaived ? "Final billing at scheduled Gate-Out (overstay fee waived)" : "Final billing at physical release";
        booking.billingRecomputeCount = Number(booking.billingRecomputeCount || 0) + 1;
        const releaseSchedule = getGateOutScheduleInfo(booking, actualReleaseTime);
        booking.gateOutScheduleStatus = releaseSchedule.status;
        booking.gateOutOverstayStartedAt = releaseSchedule.overstayStartedAt;
        booking.billingStatus = releaseCredit.balanceDue <= 0 ? "paid_approved" : "additional_payment_required";
        if (releaseCredit.balanceDue > 0) {
            addHistory(booking, {
                billingStatus: "additional_payment_required",
                remarks: `Release paused after final billing was recomputed using ${booking.overstayFeeWaived ? `the scheduled Gate-Out time ${finalBillingAsOf.toLocaleString()} because the overstay fee is waived` : `the actual server release time ${finalBillingAsOf.toLocaleString()}`}. Previous gross bill PHP ${previousTotal.toLocaleString()}, updated gross bill PHP ${releaseBilling.total.toLocaleString()}, approved payment credit PHP ${releaseCredit.approvedAmount.toLocaleString()}, balance due PHP ${releaseCredit.balanceDue.toLocaleString()}.`,
                changedBy: req.user._id,
            });
            await booking.save();
            await booking.populate("client", "name email companyName phoneNumber");
            await booking.populate("assignedArea", "name code isCongestionArea");
            await booking.populate("assignedBlock", "name code");
            await booking.populate("billingRecomputedBy", "name");
            const blockedReleasePayload = safeBooking(booking);
            (0, socket_js_1.emitToAdmins)("booking:overstay_billing_recomputed", blockedReleasePayload);
            (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:overstay_billing_recomputed", blockedReleasePayload);
            await notifyClient(booking, "Additional payment required before release", `Final billing was recalculated using ${finalBillingBasisLabel}. An additional balance must be paid and approved before the container can physically exit the yard.`, [
                { label: "Container", value: booking.containerNumber },
                { label: "Final Billing As Of", value: finalBillingAsOf.toLocaleString() },
                { label: "Updated Gross Bill", value: `PHP ${releaseBilling.total.toLocaleString()}` },
                { label: "Approved Payment Credit", value: `PHP ${releaseCredit.approvedAmount.toLocaleString()}` },
                { label: "Additional Balance Due", value: `PHP ${releaseCredit.balanceDue.toLocaleString()}` },
            ], { notificationType: "additional_payment_required" });
            return res.status(403).json({
                success: false,
                message: `Final billing changed using ${finalBillingBasisLabel}. Release cannot be completed until the additional PHP ${releaseCredit.balanceDue.toLocaleString()} is paid and approved.`,
                booking: blockedReleasePayload,
            });
        }
    }
    if (booking.billingStatus !== "paid_approved") {
        return res.status(403).json({ success: false, message: "Payment must be paid / approved before release completion." });
    }
    const actualContainerNumber = normalizeContainerNumber(req.body.actualContainerNumber || booking.containerNumber);
    if (actualContainerNumber !== booking.containerNumber) {
        return res.status(400).json({ success: false, message: "Final container number must match the booking." });
    }
    const wasAlreadyCompleted = booking.status === "completed_gate_out_done";
    const previousBlockId = booking.assignedBlock ? String(booking.assignedBlock) : "";
    const releasedAt = booking.releasedAt || new Date();
    const billingResult = {
        days: Number(booking.billingDays) || 0,
        subtotal: Number(booking.billingSubtotal) || 0,
        vatRate: Number.isFinite(Number(booking.vatRate)) ? Number(booking.vatRate) : 0,
        vatAmount: Number(booking.vatAmount) || 0,
        total: Number(booking.billingTotal || booking.paymentAmount) || 0,
    };
    const gateOutConditions = normalizeConditionSelections(req.body.gateOutConditions || booking.gateOutConditions || booking.gateInConditions);
    const gateOutConditionOther = String(req.body.gateOutConditionOther || booking.gateOutConditionOther || "").trim();
    booking.status = "completed_gate_out_done";
    booking.gateOutScheduleStatus = "released";
    booking.releasedAt = releasedAt;
    booking.releasedBy = booking.releasedBy || req.user._id;
    booking.releaseRemarks = req.body.remarks || booking.releaseRemarks || "";
    booking.gateOutConditions = gateOutConditions.length ? gateOutConditions : normalizeConditionSelections(booking.gateInConditions || ["GOOD"]);
    booking.gateOutConditionOther = gateOutConditionOther;
    if (!wasAlreadyCompleted) {
        addHistory(booking, { remarks: `Container released, final report generated, and PHP ${billingResult.total.toLocaleString()} revenue recorded.`, changedBy: req.user._id });
    }
    await booking.save();
    const reportNumber = `REL-${booking.bookingReference}`;
    const releaseReport = await ReleaseReport_js_1.default.findOneAndUpdate({ booking: booking._id }, {
        $set: {
            reportNumber,
            client: booking.client,
            bookingReference: booking.bookingReference,
            bookingNumber: booking.bookingNumber || "",
            recordSource: booking.recordSource || "client_booking",
            containerNumber: booking.containerNumber,
            containerSize: booking.containerSize,
            containerType: booking.containerType || "",
            containerLoadStatus: booking.containerLoadStatus || "",
            rateType: normalizeRateType(booking.rateType),
            serviceType: booking.serviceType || "container_yard",
            shippingLine: booking.shippingLine || "",
            gateInAt: booking.gateInApprovedAt || booking.storedAt || null,
            storageStartDate: booking.storageStartDate || booking.storedAt || booking.gateInApprovedAt || null,
            releasedAt,
            billingDays: booking.billingDays || billingResult.days || 0,
            billingSubtotal: booking.billingSubtotal || billingResult.subtotal || 0,
            vatRate: Number.isFinite(Number(booking.vatRate)) ? Number(booking.vatRate) : billingResult.vatRate,
            vatAmount: booking.vatAmount || billingResult.vatAmount || 0,
            revenueTotal: booking.billingTotal || billingResult.total || 0,
            paymentReferenceNumber: booking.paymentReferenceNumber || "",
            paymentDate: booking.paymentDate || booking.paymentReviewedAt || booking.paymentSubmittedAt || null,
            paymentStatus: booking.billingStatus,
            generatedAt: new Date(),
            generatedBy: req.user._id,
        },
    }, { new: true, upsert: true, setDefaultsOnInsert: true });
    booking.releaseReport = releaseReport._id;
    booking.reportGeneratedAt = releaseReport.generatedAt;
    booking.revenueRecordedAt = releaseReport.generatedAt;
    await booking.save();
    if (previousBlockId && !wasAlreadyCompleted)
        await recalculateBlockOccupancy(previousBlockId);
    await booking.populate("client", "name email companyName phoneNumber");
    await booking.populate("assignedArea", "name code isCongestionArea");
    await booking.populate("assignedBlock", "name code");
    await booking.populate("gateOutApprovedBy", "name");
    await booking.populate("releasedBy", "name");
    const payload = safeBooking(booking);
    (0, socket_js_1.emitToAdmins)("booking:completed", payload);
    (0, socket_js_1.emitToAdmins)("report:generated", { booking: payload, reportId: String(releaseReport._id), reportNumber, revenue: releaseReport.revenueTotal });
    if (!wasAlreadyCompleted) {
        (0, socket_js_1.emitToAdmins)("yard:slot_released", { ...payload, previousBlockId });
        (0, socket_js_1.emitToAdmins)("storage:updated", payload);
        (0, socket_js_1.emitToAdmins)("inventory:updated", payload);
        (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:completed", payload);
        await notifyClient(booking, "Container released", "Your container has successfully left the yard. The release report was generated and the booking is now completed.", [
            { label: "Container", value: booking.containerNumber },
            { label: "Release Report", value: reportNumber },
        ]);
    }
    return res.json({
        success: true,
        message: wasAlreadyCompleted ? "Release report and revenue record refreshed." : "Gate-out completed. Release report generated and revenue recorded.",
        booking: payload,
        releaseReport: {
            id: String(releaseReport._id),
            reportNumber: releaseReport.reportNumber,
            generatedAt: releaseReport.generatedAt,
            revenueTotal: Number(releaseReport.revenueTotal) || 0,
        },
    });
};
exports.completeBookingGateOut = completeBookingGateOut;
const cancelExpiredGateInNoShows = async ({ now = new Date(), graceHours = Number(process.env.GATE_IN_NO_SHOW_GRACE_HOURS || 24) } = {}) => {
    const safeGraceHours = Number.isFinite(Number(graceHours)) ? Math.max(Number(graceHours), 1) : 24;
    const cutoff = new Date(new Date(now).getTime() - safeGraceHours * 60 * 60 * 1000);
    const candidates = await Booking_js_1.default.find({
        status: "approved_area_assigned",
        gateInApprovedAt: null,
        $or: [
            { inDate: { $lte: cutoff } },
            { inDate: null, expectedArrivalDate: { $lte: cutoff } },
        ],
    });
    let cancelledCount = 0;
    for (const booking of candidates) {
        try {
            const previousBlockId = booking.assignedBlock ? String(booking.assignedBlock) : "";
            const previousSlot = booking.assignedSlotNumber || "";
            const scheduledIn = booking.inDate || booking.expectedArrivalDate;
            booking.status = "cancelled";
            booking.rejectionReason = `Automatically cancelled after no Gate-In arrival within ${safeGraceHours} hours of the scheduled time.`;
            booking.gateOutScheduleStatus = "cancelled";
            booking.assignedArea = null;
            booking.assignedBlock = null;
            booking.assignedBay = 1;
            booking.assignedRow = 1;
            booking.assignedTier = 1;
            booking.assignedSlotNumber = "";
            booking.assignedAt = null;
            booking.assignedBy = null;
            booking.additionalBillingCharges = (booking.additionalBillingCharges || []).filter((item) => item.source !== "congestion_surcharge");
            addHistory(booking, {
                remarks: `System auto-cancelled this Gate-In no-show after ${safeGraceHours} hours. Scheduled Gate-In: ${scheduledIn ? new Date(scheduledIn).toLocaleString() : "-"}. Reserved yard slot ${previousSlot || "-"} was released.`,
                changedBy: null,
            });
            await booking.save();
            if (previousBlockId)
                await recalculateBlockOccupancy(previousBlockId);
            await booking.populate("client", "name email companyName phoneNumber");
            const payload = safeBooking(booking);
            (0, socket_js_1.emitToAdmins)("booking:gate_in_no_show_cancelled", payload);
            (0, socket_js_1.emitToAdmins)("yard:slot_released", { ...payload, previousBlockId, previousSlot });
            (0, socket_js_1.emitToAdmins)("inventory:updated", payload);
            (0, socket_js_1.emitToUser)(booking.client?._id || booking.client, "booking:gate_in_no_show_cancelled", payload);
            await notifyClient(booking, "Gate-In booking automatically cancelled", `No Gate-In arrival was recorded within ${safeGraceHours} hours after the scheduled Gate-In time, so the reservation was automatically cancelled and the yard slot was released.`, [
                { label: "Container", value: booking.containerNumber },
                { label: "Scheduled Gate-In", value: scheduledIn ? new Date(scheduledIn).toLocaleString() : "-" },
                { label: "Released Slot", value: previousSlot || "-" },
            ], { notificationType: "gate_in_no_show_cancelled" });
            cancelledCount += 1;
        }
        catch (error) {
            console.error(`Failed to auto-cancel Gate-In no-show ${booking?._id}:`, error);
        }
    }
    return { cancelledCount, checkedCount: candidates.length, cutoff };
};
exports.cancelExpiredGateInNoShows = cancelExpiredGateInNoShows;
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
    await booking.populate("assignedArea", "name code isCongestionArea");
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
    const [total, pending, approved, gateIn, stored, gateOutRequested, gateOutReversalRequested, completed, unpaid, paymentReview, paid] = await Promise.all([
        Booking_js_1.default.countDocuments(),
        Booking_js_1.default.countDocuments({ status: "pending_admin_approval" }),
        Booking_js_1.default.countDocuments({ status: "approved_area_assigned" }),
        Booking_js_1.default.countDocuments({ status: "gate_in_approved" }),
        Booking_js_1.default.countDocuments({ status: "stored_in_assigned_area" }),
        Booking_js_1.default.countDocuments({ status: "gate_out_requested" }),
        Booking_js_1.default.countDocuments({ status: "gate_out_reversal_requested" }),
        Booking_js_1.default.countDocuments({ status: "completed_gate_out_done" }),
        Booking_js_1.default.countDocuments({ billingStatus: "unpaid" }),
        Booking_js_1.default.countDocuments({ billingStatus: "payment_under_review" }),
        Booking_js_1.default.countDocuments({ billingStatus: "paid_approved" }),
    ]);
    return res.json({
        success: true,
        summary: { total, pending, approved, gateIn, stored, gateOutRequested, gateOutReversalRequested, completed, unpaid, paymentReview, paid },
    });
};
exports.getBookingSummary = getBookingSummary;
