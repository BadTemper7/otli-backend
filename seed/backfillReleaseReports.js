"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const mongoose_1 = __importDefault(require("mongoose"));
const Booking_js_1 = __importDefault(require("../models/Booking.js"));
const ReleaseReport_js_1 = __importDefault(require("../models/ReleaseReport.js"));
dotenv_1.default.config();
const normalizeRateType = (value) => String(value || "").toLowerCase() === "international" ? "international" : "local";
const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const getPaymentTotal = (booking, stage) => roundMoney((booking.paymentTransactions || [])
    .filter((item) => item.paymentStage === stage)
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0));
const getBillingTotal = (booking, stage) => {
    const transactions = (booking.paymentTransactions || []).filter((item) => item.paymentStage === stage);
    const archivedTotal = transactions.length > 0
        ? Math.max(...transactions.map((item) => Number(item.grossTotal) || Number(item.amount) || 0), 0)
        : 0;
    const currentStage = booking.billingStage === "gate_in" ? "gate_in" : "gate_out";
    const currentTotal = currentStage === stage ? Number(booking.billingTotal) || 0 : 0;
    return roundMoney(Math.max(archivedTotal, currentTotal));
};
const backfillReleaseReports = async () => {
    try {
        if (!process.env.MONGODB_URI)
            throw new Error("MONGODB_URI is missing in the environment.");
        await mongoose_1.default.connect(process.env.MONGODB_URI);
        const bookings = await Booking_js_1.default.find({ status: "completed_gate_out_done" });
        let createdOrUpdated = 0;
        let skipped = 0;
        for (const booking of bookings) {
            if (!booking.client || !booking.bookingReference || !booking.containerNumber) {
                skipped += 1;
                continue;
            }
            const releasedAt = booking.releasedAt || booking.outDate || booking.updatedAt || new Date();
            const generatedAt = booking.reportGeneratedAt || releasedAt;
            const gateInPaymentTotal = getPaymentTotal(booking, "gate_in");
            const gateOutPaymentTotal = getPaymentTotal(booking, "gate_out");
            const archivedPaidTotal = roundMoney(gateInPaymentTotal + gateOutPaymentTotal);
            const legacyPaidFallback = roundMoney(Number(booking.approvedPaymentAmount || booking.paymentAmount || booking.billingTotal) || 0);
            const totalPaidAmount = archivedPaidTotal > 0 ? archivedPaidTotal : legacyPaidFallback;
            const gateInBillingTotal = getBillingTotal(booking, "gate_in");
            const gateOutBillingTotal = getBillingTotal(booking, "gate_out");
            const totalBillingAmount = roundMoney(gateInBillingTotal + gateOutBillingTotal);
            const releaseReport = await ReleaseReport_js_1.default.findOneAndUpdate({ booking: booking._id }, {
                $set: {
                    reportNumber: `REL-${booking.bookingReference}`,
                    client: booking.client,
                    bookingReference: booking.bookingReference,
                    bookingNumber: booking.bookingNumber || "",
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
                    billingDays: Number(booking.billingDays) || 0,
                    billingSubtotal: Number(booking.billingSubtotal) || 0,
                    vatRate: Number.isFinite(Number(booking.vatRate)) ? Number(booking.vatRate) : 0,
                    vatAmount: Number(booking.vatAmount) || 0,
                    gateInBillingTotal,
                    gateInPaymentTotal,
                    gateOutBillingTotal,
                    gateOutPaymentTotal,
                    totalBillingAmount,
                    totalPaidAmount,
                    revenueTotal: totalPaidAmount,
                    paymentReferenceNumber: booking.paymentReferenceNumber || "",
                    paymentDate: booking.paymentDate || booking.paymentReviewedAt || booking.paymentSubmittedAt || null,
                    paymentStatus: booking.billingStatus || "paid_approved",
                    generatedAt,
                    generatedBy: booking.releasedBy || booking.paymentReviewedBy || null,
                },
            }, { new: true, upsert: true, setDefaultsOnInsert: true });
            booking.releaseReport = releaseReport._id;
            booking.reportGeneratedAt = releaseReport.generatedAt;
            booking.revenueRecordedAt = booking.revenueRecordedAt || releaseReport.generatedAt;
            await booking.save();
            createdOrUpdated += 1;
        }
        console.log(`Release report backfill complete. Updated: ${createdOrUpdated}. Skipped: ${skipped}.`);
        await mongoose_1.default.disconnect();
        process.exit(0);
    }
    catch (error) {
        console.error(`Release report backfill failed: ${error.message}`);
        await mongoose_1.default.disconnect().catch(() => null);
        process.exit(1);
    }
};
backfillReleaseReports();
