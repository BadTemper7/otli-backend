"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPaymentHistory = void 0;
const Booking_js_1 = require("../models/Booking.js");
const normalizeRateType = (value) => String(value || "").trim().toLowerCase() === "international" ? "international" : "local";
const toTransactionLineItem = (item = {}, fallbackRateType = "local") => ({
    rate: item.rate || null,
    chargeCode: String(item.chargeCode || "").trim(),
    description: String(item.description || item.chargeCode || "Billing charge").trim(),
    unit: String(item.unit || "per_container").trim(),
    quantity: Number(item.quantity) || 1,
    rateAmount: Number(item.rateAmount) || Number(item.amount) || 0,
    freeDays: Number(item.freeDays) || 0,
    minimumAmount: Number(item.minimumAmount) || 0,
    category: String(item.category || "").trim(),
    billingScope: String(item.billingScope || "").trim(),
    rateType: normalizeRateType(item.rateType || fallbackRateType),
    amount: Number(item.amount) || 0,
});
const resolveTransactionLineItems = (booking, payment = null) => {
    const rateType = normalizeRateType(booking.rateType);
    if (Array.isArray(payment?.lineItems) && payment.lineItems.length > 0) {
        return { lineItems: payment.lineItems.map((item) => toTransactionLineItem(item, rateType)), source: "payment_snapshot" };
    }
    if (Array.isArray(booking.billingLineItems) && booking.billingLineItems.length > 0) {
        return { lineItems: booking.billingLineItems.map((item) => toTransactionLineItem(item, rateType)), source: "booking_billing" };
    }
    const paymentType = String(payment?.paymentTypeSnapshot?.type || booking.paymentTypeSnapshot?.type || "").trim().toLowerCase();
    const paymentName = String(payment?.paymentTypeSnapshot?.name || booking.paymentTypeSnapshot?.name || "").trim().toLowerCase();
    const isLegacyOpeningCredit = booking.recordSource === "legacy_migration" &&
        (paymentType === "legacy" || paymentName.includes("opening credit") || Number(booking.openingCreditAmount || 0) > 0);
    if (isLegacyOpeningCredit) {
        const amount = Number(payment?.subtotal) || Number(payment?.amount) || Number(booking.openingCreditAmount) || 0;
        if (amount > 0) {
            return {
                lineItems: [toTransactionLineItem({
                    chargeCode: "LEGACY_OPENING_CREDIT",
                    description: "Opening credit from records before system migration",
                    unit: "opening_credit",
                    quantity: 1,
                    rateAmount: amount,
                    category: "legacy",
                    billingScope: "opening_credit",
                    rateType,
                    amount,
                }, rateType)],
                source: "legacy_opening_credit",
            };
        }
    }
    if (Array.isArray(booking.additionalBillingCharges) && booking.additionalBillingCharges.length > 0) {
        const additionalItems = booking.additionalBillingCharges
            .filter((item) => Number(item.amount) > 0)
            .map((item) => toTransactionLineItem({
                ...item,
                unit: item.unit || "manual_charge",
                category: item.category || "additional",
                billingScope: item.billingScope || "additional",
                rateType,
            }, rateType));
        if (additionalItems.length > 0) {
            return { lineItems: additionalItems, source: "booking_additional_charges" };
        }
    }
    const fallbackAmount = Number(payment?.subtotal ?? booking.billingSubtotal) ||
        Number(payment?.amount ?? booking.billingTotal ?? booking.paymentAmount) || 0;
    if (fallbackAmount > 0) {
        const legacy = booking.recordSource === "legacy_migration";
        return {
            lineItems: [toTransactionLineItem({
                chargeCode: legacy ? "LEGACY_BILLING_AMOUNT" : "BILLING_AMOUNT",
                description: legacy ? "Historical billing amount from migrated records" : "Billing amount",
                unit: "unitemized",
                quantity: 1,
                rateAmount: fallbackAmount,
                category: legacy ? "legacy" : "billing",
                billingScope: "fallback",
                rateType,
                amount: fallbackAmount,
            }, rateType)],
            source: "amount_fallback",
        };
    }
    return { lineItems: [], source: "none" };
};
const listPaymentHistory = async (req, res) => {
    const query = {
        $or: [
            { billingStatus: "paid_approved" },
            { status: "completed_gate_out_done" },
            { approvedPaymentAmount: { $gt: 0 } },
            { "paymentTransactions.0": { $exists: true } },
        ],
    };
    if (req.query.search) {
        const escaped = String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(escaped, "i");
        query.$and = [{ $or: [{ bookingReference: pattern }, { containerNumber: pattern }, { paymentReferenceNumber: pattern }] }];
    }
    const bookings = await Booking_js_1.default.find(query)
        .populate("client", "name companyName email")
        .sort({ paymentReviewedAt: -1, paymentDate: -1, updatedAt: -1 })
        .limit(2000)
        .lean();
    const buildTransaction = (booking, payment = null, index = 0) => {
        const breakdown = resolveTransactionLineItems(booking, payment);
        return ({
        id: payment?._id ? `${booking._id}-${payment._id}` : String(booking._id),
        bookingId: String(booking._id),
        bookingReference: booking.bookingReference,
        recordSource: booking.recordSource || "client_booking",
        legacyRegistrationNumber: booking.legacyRegistrationNumber || "",
        containerNumber: booking.containerNumber,
        containerSize: Number(booking.containerSize) || 20,
        containerType: booking.containerType || "",
        containerLoadStatus: booking.containerLoadStatus || "empty",
        rateType: normalizeRateType(booking.rateType),
        clientName: booking.client?.companyName || booking.client?.name || booking.client?.email || "Unknown Client",
        clientEmail: booking.client?.email || "",
        status: booking.status,
        billingStatus: booking.billingStatus,
        subtotal: Number(payment?.subtotal ?? booking.billingSubtotal) || 0,
        isVatApplicable: payment?.isVatApplicable ?? booking.isVatApplicable ?? true,
        vatRate: Number(payment?.vatRate ?? booking.vatRate) || 0,
        vatAmount: Number(payment?.vatAmount ?? booking.vatAmount) || 0,
        total: Number(payment?.amount ?? booking.billingTotal ?? booking.paymentAmount) || 0,
        grossBillingTotal: Number(payment?.grossTotal ?? booking.billingTotal) || 0,
        approvedPaymentAmount: Number(booking.approvedPaymentAmount) || 0,
        paymentCreditAmount: Number(booking.paymentCreditAmount) || 0,
        paymentBalanceDue: Number(booking.paymentBalanceDue) || 0,
        paymentApplicationStatus: booking.paymentApplicationStatus || "none",
        paymentType: payment?.paymentTypeSnapshot?.name || payment?.paymentTypeSnapshot?.type || booking.paymentTypeSnapshot?.name || booking.paymentTypeSnapshot?.type || "Unknown",
        paymentTypeCategory: payment?.paymentTypeSnapshot?.type || booking.paymentTypeSnapshot?.type || "",
        paymentReferenceNumber: payment?.referenceNumber || booking.paymentReferenceNumber || "",
        paymentDate: payment?.paymentDate || payment?.approvedAt || booking.paymentDate || booking.paymentReviewedAt || booking.updatedAt,
        receiptNumber: payment?.receiptNumber || booking.receiptNumber || "",
        receiptType: payment?.receiptType || booking.receiptType || (booking.isVatApplicable === false ? "acknowledgement_receipt" : "official_receipt"),
        receiptGeneratedAt: payment?.approvedAt || booking.receiptGeneratedAt || null,
        cashReceived: Number(payment?.cashReceived ?? booking.cashReceived) || 0,
        changeAmount: Number(payment?.changeAmount ?? booking.changeAmount) || 0,
        source: payment?.source || (booking.paymentTypeSnapshot?.type === "cash" ? "cash" : "legacy"),
        sequence: index + 1,
        lineItems: breakdown.lineItems,
        lineItemsSource: breakdown.source,
    });
    };
    const transactions = bookings.flatMap((booking) => {
        const archived = Array.isArray(booking.paymentTransactions) ? booking.paymentTransactions : [];
        if (archived.length > 0)
            return archived.map((payment, index) => buildTransaction(booking, payment, index));
        return [buildTransaction(booking)];
    }).sort((left, right) => new Date(right.paymentDate || 0).getTime() - new Date(left.paymentDate || 0).getTime());
    return res.json({ success: true, transactions });
};
exports.listPaymentHistory = listPaymentHistory;
