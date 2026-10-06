"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPaymentHistory = void 0;
const Booking_js_1 = require("../models/Booking.js");
const normalizeRateType = (value) => String(value || "").trim().toLowerCase() === "international" ? "international" : "local";
const listPaymentHistory = async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit || req.query.pageSize) || 10, 1), 100);
    const match = {
        $or: [
            { billingStatus: "paid_approved" },
            { status: "completed_gate_out_done" },
            { approvedPaymentAmount: { $gt: 0 } },
            { "paymentTransactions.0": { $exists: true } },
        ],
    };
    if (["empty", "laden"].includes(String(req.query.loadStatus || "").toLowerCase())) {
        match.containerLoadStatus = String(req.query.loadStatus).toLowerCase();
    }
    if (["local", "international"].includes(String(req.query.rateType || "").toLowerCase())) {
        match.rateType = String(req.query.rateType).toLowerCase();
    }
    const postMatch = {};
    const paymentType = String(req.query.paymentType || "").trim().toLowerCase();
    if (paymentType && paymentType !== "all") postMatch.effectivePaymentType = paymentType;
    if (req.query.search) {
        const escaped = String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(escaped, "i");
        postMatch.$or = [
            { bookingReference: pattern },
            { containerNumber: pattern },
            { paymentReferenceNumber: pattern },
            { "transactionEntry.referenceNumber": pattern },
            { "transactionEntry.receiptNumber": pattern },
            { "client.name": pattern },
            { "client.companyName": pattern },
            { "client.email": pattern },
        ];
    }
    const pipeline = [
        { $match: match },
        { $set: {
            transactionEntries: {
                $cond: [
                    { $gt: [{ $size: { $ifNull: ["$paymentTransactions", []] } }, 0] },
                    "$paymentTransactions",
                    [null],
                ],
            },
        } },
        { $unwind: "$transactionEntries" },
        { $set: { transactionEntry: "$transactionEntries" } },
        { $lookup: { from: "users", localField: "client", foreignField: "_id", as: "clientDoc" } },
        { $set: {
            client: { $arrayElemAt: ["$clientDoc", 0] },
            effectivePaymentType: { $toLower: { $ifNull: ["$transactionEntry.paymentTypeSnapshot.type", { $ifNull: ["$paymentTypeSnapshot.type", "unknown"] }] } },
            effectivePaymentDate: { $ifNull: [
                "$transactionEntry.paymentDate",
                { $ifNull: ["$transactionEntry.approvedAt", { $ifNull: ["$paymentDate", { $ifNull: ["$paymentReviewedAt", "$updatedAt"] }] }] },
            ] },
        } },
        ...(Object.keys(postMatch).length ? [{ $match: postMatch }] : []),
        { $sort: { effectivePaymentDate: -1, _id: -1 } },
        { $facet: {
            data: [{ $skip: (page - 1) * limit }, { $limit: limit }],
            meta: [{ $count: "total" }],
        } },
    ];
    const [result = { data: [], meta: [] }] = await Booking_js_1.default.aggregate(pipeline);
    const total = Number(result.meta?.[0]?.total) || 0;
    const buildTransaction = (booking, payment = null, index = 0) => ({
        id: payment?._id ? `${booking._id}-${payment._id}` : String(booking._id),
        paymentStage: payment?.paymentStage || (booking.loloPaymentStage === "gate_in" ? "gate_in" : "gate_out"),
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
        lineItems: payment?.lineItems?.length ? payment.lineItems : (booking.billingLineItems || []),
    });
    const transactions = (result.data || []).map((booking) => buildTransaction(booking, booking.transactionEntry || null, 0));
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    return res.json({
        success: true,
        transactions,
        pagination: { page, currentPage: page, limit, perPage: limit, total, totalPages },
    });
};
exports.listPaymentHistory = listPaymentHistory;
