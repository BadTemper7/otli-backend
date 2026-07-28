"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getYardContainerReport = void 0;
const Booking_js_1 = __importDefault(require("../models/Booking.js"));
const User_js_1 = __importDefault(require("../models/User.js"));
const ACTIVE_YARD_STATUSES = [
    "approved_area_assigned",
    "gate_in_approved",
    "stored_in_assigned_area",
    "gate_out_requested",
    "gate_out_approved",
];
const emptySizeCounts = () => ({ 20: 0, 40: 0, total: 0 });
const addContainer = (bucket, size) => {
    const normalizedSize = [20, 40].includes(Number(size)) ? Number(size) : 20;
    bucket[normalizedSize] += 1;
    bucket.total += 1;
};
const getTeu = (size) => {
    if (Number(size) === 40)
        return 2;
    return 1;
};
const getFeu = (size) => {
    if (Number(size) === 20)
        return 0.5;
    return 1;
};
const buildDateQuery = (startDate, endDate) => {
    const dateQuery = {};
    if (startDate) {
        const start = new Date(String(startDate));
        if (!Number.isNaN(start.getTime())) {
            start.setHours(0, 0, 0, 0);
            dateQuery.$gte = start;
        }
    }
    if (endDate) {
        const end = new Date(String(endDate));
        if (!Number.isNaN(end.getTime())) {
            end.setHours(23, 59, 59, 999);
            dateQuery.$lte = end;
        }
    }
    return Object.keys(dateQuery).length ? dateQuery : null;
};
const getYardContainerReport = async (req, res) => {
    const query = { status: { $in: ACTIVE_YARD_STATUSES } };
    if (req.query.clientId) query.client = req.query.clientId;
    const dateQuery = buildDateQuery(req.query.startDate, req.query.endDate);
    if (dateQuery) {
        query.$or = [
            { inDate: dateQuery },
            { storageStartDate: dateQuery },
            { assignedAt: dateQuery },
            { createdAt: dateQuery },
        ];
    }
    const bookings = await Booking_js_1.default.find(query)
        .select("client containerSize containerLoadStatus rateType shippingLine status assignedArea assignedBlock inDate storageStartDate assignedAt createdAt")
        .populate("client", "name companyName email")
        .lean();
    const revenueQuery = { billingStatus: "paid_approved" };
    if (req.query.clientId) revenueQuery.client = req.query.clientId;
    if (dateQuery) {
        revenueQuery.$or = [
            { paymentDate: dateQuery },
            { paymentReviewedAt: dateQuery },
            { createdAt: dateQuery },
        ];
    }
    const [revenueBookings, clientUsers] = await Promise.all([
        Booking_js_1.default.find(revenueQuery)
            .select("client billingSubtotal vatAmount billingTotal paymentDate paymentReviewedAt createdAt")
            .populate("client", "name companyName email")
            .lean(),
        User_js_1.default.find({ userType: "client" }).select("name companyName email").sort({ companyName: 1, name: 1 }).lean(),
    ]);
    const empty = emptySizeCounts();
    const laden = emptySizeCounts();
    const international = emptySizeCounts();
    const gothong = emptySizeCounts();
    let totalTeu = 0;
    let totalFeu = 0;
    const revenueByClient = new Map();
    for (const booking of bookings) {
        const size = Number(booking.containerSize) || 20;
        const loadStatus = String(booking.containerLoadStatus || "laden").toLowerCase();
        addContainer(loadStatus === "empty" ? empty : laden, size);
        if (String(booking.rateType || "").toLowerCase() === "international") {
            addContainer(international, size);
        }
        if (/gothong/i.test(String(booking.shippingLine || ""))) {
            addContainer(gothong, size);
        }
        totalTeu += getTeu(size);
        totalFeu += getFeu(size);

    }
    for (const booking of revenueBookings) {
        const clientId = booking.client?._id ? String(booking.client._id) : String(booking.client || "");
        if (!clientId) continue;
        const clientName = booking.client?.companyName || booking.client?.name || booking.client?.email || "Unknown Client";
        const current = revenueByClient.get(clientId) || { clientId, clientName, bookingCount: 0, subtotal: 0, vat: 0, revenue: 0 };
        current.bookingCount += 1;
        current.subtotal += Number(booking.billingSubtotal) || 0;
        current.vat += Number(booking.vatAmount) || 0;
        current.revenue += Number(booking.billingTotal) || 0;
        revenueByClient.set(clientId, current);
    }
    const clientOptions = clientUsers.map((client) => ({
        id: String(client._id),
        name: client.companyName || client.name || client.email || "Unnamed Client",
    }));
    const clientRevenue = Array.from(revenueByClient.values()).map((item) => ({
        ...item,
        subtotal: Math.round(item.subtotal * 100) / 100,
        vat: Math.round(item.vat * 100) / 100,
        revenue: Math.round(item.revenue * 100) / 100,
    })).sort((a, b) => b.revenue - a.revenue);
    return res.json({
        success: true,
        generatedAt: new Date(),
        filters: {
            startDate: req.query.startDate || "",
            endDate: req.query.endDate || "",
            clientId: req.query.clientId || "",
        },
        report: {
            totalContainersInYard: bookings.length,
            empty,
            laden,
            international,
            gothong,
            totalTeu: Math.round(totalTeu * 100) / 100,
            totalFeu: Math.round(totalFeu * 100) / 100,
            clientRevenue,
            clientOptions,
        },
    });
};
exports.getYardContainerReport = getYardContainerReport;
