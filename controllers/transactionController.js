"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPaymentHistory = void 0;
const Booking_js_1 = require("../models/Booking.js");
const listPaymentHistory = async (req, res) => {
    const query = {
        $or: [
            { billingStatus: "paid_approved" },
            { status: "completed_gate_out_done" },
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
    const transactions = bookings.map((booking) => ({
        id: String(booking._id),
        bookingReference: booking.bookingReference,
        containerNumber: booking.containerNumber,
        clientName: booking.client?.companyName || booking.client?.name || booking.client?.email || "Unknown Client",
        clientEmail: booking.client?.email || "",
        status: booking.status,
        billingStatus: booking.billingStatus,
        subtotal: Number(booking.billingSubtotal) || 0,
        vatRate: Number(booking.vatRate) || 0,
        vatAmount: Number(booking.vatAmount) || 0,
        total: Number(booking.billingTotal || booking.paymentAmount) || 0,
        isVatApplicable: booking.isVatApplicable !== false,
        paymentType: booking.paymentTypeSnapshot?.name || booking.paymentTypeSnapshot?.type || "Unknown",
        paymentTypeCategory: booking.paymentTypeSnapshot?.type || "",
        paymentReferenceNumber: booking.paymentReferenceNumber || "",
        paymentDate: booking.paymentDate || booking.paymentReviewedAt || booking.updatedAt,
        receiptNumber: booking.receiptNumber || "",
        receiptType: booking.receiptType || (booking.isVatApplicable === false ? "acknowledgement_receipt" : "official_receipt"),
        receiptGeneratedAt: booking.receiptGeneratedAt || null,
        cashReceived: Number(booking.cashReceived) || 0,
        changeAmount: Number(booking.changeAmount) || 0,
        lineItems: booking.billingLineItems || [],
    }));
    return res.json({ success: true, transactions });
};
exports.listPaymentHistory = listPaymentHistory;
