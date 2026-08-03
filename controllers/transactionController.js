"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPaymentHistory = void 0;
const Booking_js_1 = require("../models/Booking.js");
const normalizeRateType = (value) => String(value || "").trim().toLowerCase() === "international" ? "international" : "local";
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
    const buildTransaction = (booking, payment = null, index = 0) => ({
        id: payment?._id ? `${booking._id}-${payment._id}` : String(booking._id),
        bookingId: String(booking._id),
        bookingReference: booking.bookingReference,
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
        lineItems: payment?.lineItems?.length ? payment.lineItems : (booking.billingLineItems || []),
    });
    const transactions = bookings.flatMap((booking) => {
        const archived = Array.isArray(booking.paymentTransactions) ? booking.paymentTransactions : [];
        if (archived.length > 0)
            return archived.map((payment, index) => buildTransaction(booking, payment, index));
        return [buildTransaction(booking)];
    }).sort((left, right) => new Date(right.paymentDate || 0).getTime() - new Date(left.paymentDate || 0).getTime());
    return res.json({ success: true, transactions });
};
exports.listPaymentHistory = listPaymentHistory;
