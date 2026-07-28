"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOperationsDashboard = exports.getYardContainerReport = void 0;
const Booking_js_1 = __importDefault(require("../models/Booking.js"));
const User_js_1 = __importDefault(require("../models/User.js"));
const YardBlock_js_1 = __importDefault(require("../models/YardBlock.js"));
const ReleaseReport_js_1 = __importDefault(require("../models/ReleaseReport.js"));
const ACTIVE_YARD_STATUSES = [
    "approved_area_assigned",
    "gate_in_approved",
    "stored_in_assigned_area",
    "gate_out_requested",
    "gate_out_approved",
];
const CURRENT_INVENTORY_STATUSES = [
    "gate_in_approved",
    "stored_in_assigned_area",
    "gate_out_requested",
    "gate_out_approved",
];
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const emptySizeCounts = () => ({ 20: 0, 40: 0, total: 0 });
const addContainer = (bucket, size) => {
    const normalizedSize = [20, 40].includes(Number(size)) ? Number(size) : 20;
    bucket[normalizedSize] += 1;
    bucket.total += 1;
};
const getTeu = (size) => Number(size) === 40 ? 2 : 1;
const getFeu = (size) => Number(size) === 20 ? 0.5 : 1;
const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const normalizeRateType = (value) => String(value || "").toLowerCase() === "international" ? "international" : "local";
const normalizeKey = (value) => String(value || "all").trim().toLowerCase();
const buildDateQuery = (startDate, endDate) => {
    const dateQuery = {};
    const parseParts = (value) => {
        const [year, month, day] = String(value || "").slice(0, 10).split("-").map(Number);
        return year && month && day ? { year, month: month - 1, day } : null;
    };
    const startParts = parseParts(startDate);
    if (startParts) {
        dateQuery.$gte = toUtcFromManilaParts(startParts.year, startParts.month, startParts.day);
    }
    const endParts = parseParts(endDate);
    if (endParts) {
        dateQuery.$lte = toUtcFromManilaParts(endParts.year, endParts.month, endParts.day, 23, 59, 59, 999);
    }
    return Object.keys(dateQuery).length ? dateQuery : null;
};
const toUtcFromManilaParts = (year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) => {
    return new Date(Date.UTC(year, month, day, hour, minute, second, millisecond) - MANILA_OFFSET_MS);
};
const getDashboardRange = (periodValue = "daily", now = new Date()) => {
    const period = ["daily", "weekly", "monthly", "yearly"].includes(String(periodValue)) ? String(periodValue) : "daily";
    const manilaNow = new Date(now.getTime() + MANILA_OFFSET_MS);
    const year = manilaNow.getUTCFullYear();
    const month = manilaNow.getUTCMonth();
    const day = manilaNow.getUTCDate();
    let start;
    if (period === "yearly") {
        start = toUtcFromManilaParts(year, 0, 1);
    }
    else if (period === "monthly") {
        start = toUtcFromManilaParts(year, month, 1);
    }
    else if (period === "weekly") {
        const weekday = manilaNow.getUTCDay();
        const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
        start = toUtcFromManilaParts(year, month, day - daysSinceMonday);
    }
    else {
        start = toUtcFromManilaParts(year, month, day);
    }
    return { period, start, end: now };
};
const safeReleaseReport = (report) => {
    const client = report.client || {};
    return {
        id: String(report._id),
        reportNumber: report.reportNumber,
        booking: report.booking ? String(report.booking?._id || report.booking) : "",
        bookingReference: report.bookingReference,
        bookingNumber: report.bookingNumber || "",
        clientId: client?._id ? String(client._id) : String(report.client || ""),
        clientName: client.companyName || client.name || client.email || "Unknown Client",
        containerNumber: report.containerNumber,
        containerSize: Number(report.containerSize) || 20,
        rateType: normalizeRateType(report.rateType),
        shippingLine: report.shippingLine || "",
        releasedAt: report.releasedAt,
        billingDays: Number(report.billingDays) || 0,
        billingSubtotal: roundMoney(report.billingSubtotal),
        vatAmount: roundMoney(report.vatAmount),
        revenueTotal: roundMoney(report.revenueTotal),
        paymentReferenceNumber: report.paymentReferenceNumber || "",
        generatedAt: report.generatedAt,
    };
};
const getYardContainerReport = async (req, res) => {
    const query = { status: { $in: ACTIVE_YARD_STATUSES } };
    if (req.query.clientId)
        query.client = req.query.clientId;
    const dateQuery = buildDateQuery(req.query.startDate, req.query.endDate);
    if (dateQuery) {
        query.$or = [
            { inDate: dateQuery },
            { storageStartDate: dateQuery },
            { assignedAt: dateQuery },
            { createdAt: dateQuery },
        ];
    }
    const releaseQuery = {};
    if (req.query.clientId)
        releaseQuery.client = req.query.clientId;
    if (dateQuery)
        releaseQuery.releasedAt = dateQuery;
    const [bookings, releaseReports, clientUsers] = await Promise.all([
        Booking_js_1.default.find(query)
            .select("client containerSize containerLoadStatus rateType shippingLine status assignedArea assignedBlock inDate storageStartDate assignedAt createdAt")
            .populate("client", "name companyName email")
            .lean(),
        ReleaseReport_js_1.default.find(releaseQuery)
            .populate("client", "name companyName email")
            .sort({ releasedAt: -1, generatedAt: -1 })
            .limit(1000)
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
        if (normalizeRateType(booking.rateType) === "international")
            addContainer(international, size);
        if (/gothong/i.test(String(booking.shippingLine || "")))
            addContainer(gothong, size);
        totalTeu += getTeu(size);
        totalFeu += getFeu(size);
    }
    for (const report of releaseReports) {
        const clientId = report.client?._id ? String(report.client._id) : String(report.client || "");
        if (!clientId)
            continue;
        const clientName = report.client?.companyName || report.client?.name || report.client?.email || "Unknown Client";
        const current = revenueByClient.get(clientId) || { clientId, clientName, bookingCount: 0, subtotal: 0, vat: 0, revenue: 0 };
        current.bookingCount += 1;
        current.subtotal += Number(report.billingSubtotal) || 0;
        current.vat += Number(report.vatAmount) || 0;
        current.revenue += Number(report.revenueTotal) || 0;
        revenueByClient.set(clientId, current);
    }
    const clientOptions = clientUsers.map((client) => ({
        id: String(client._id),
        name: client.companyName || client.name || client.email || "Unnamed Client",
    }));
    const clientRevenue = Array.from(revenueByClient.values()).map((item) => ({
        ...item,
        subtotal: roundMoney(item.subtotal),
        vat: roundMoney(item.vat),
        revenue: roundMoney(item.revenue),
    })).sort((a, b) => b.revenue - a.revenue);
    const totalRecordedRevenue = roundMoney(releaseReports.reduce((sum, item) => sum + (Number(item.revenueTotal) || 0), 0));
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
            releasedContainers: releaseReports.length,
            totalRecordedRevenue,
            releaseReports: releaseReports.map(safeReleaseReport),
            clientRevenue,
            clientOptions,
        },
    });
};
exports.getYardContainerReport = getYardContainerReport;
const getOperationsDashboard = async (req, res) => {
    const now = new Date();
    const range = getDashboardRange(req.query.period, now);
    const dateFilter = { $gte: range.start, $lte: range.end };
    const [receivedCount, releasedCount, currentInventoryBookings, yardBlocks, revenueAggregate, recentAccounts, pendingClients, pendingBookings, gateOutRequests] = await Promise.all([
        Booking_js_1.default.countDocuments({ gateInApprovedAt: dateFilter }),
        ReleaseReport_js_1.default.countDocuments({ releasedAt: dateFilter }),
        Booking_js_1.default.find({ status: { $in: CURRENT_INVENTORY_STATUSES } })
            .select("containerNumber containerSize status")
            .lean(),
        YardBlock_js_1.default.find({ status: { $in: ["active", "full"] } }).select("teuSlots occupiedSlots").lean(),
        ReleaseReport_js_1.default.aggregate([
            { $match: { releasedAt: dateFilter } },
            { $group: { _id: null, revenue: { $sum: "$revenueTotal" }, subtotal: { $sum: "$billingSubtotal" }, vat: { $sum: "$vatAmount" } } },
        ]),
        User_js_1.default.find().select("name email userType role status companyName createdAt").sort({ createdAt: -1 }).limit(10).lean(),
        User_js_1.default.countDocuments({ userType: "client", status: { $in: ["pending", "resubmitted"] } }),
        Booking_js_1.default.countDocuments({ status: "pending_admin_approval" }),
        Booking_js_1.default.countDocuments({ status: "gate_out_requested" }),
    ]);
    // A container is considered overstaying once its Gate-Out request has been
    // approved but the physical release has not yet been completed.
    const overstayingContainers = currentInventoryBookings.filter((booking) => booking.status === "gate_out_approved").length;
    const totalYardCapacity = yardBlocks.reduce((sum, block) => sum + (Number(block.teuSlots) || 0), 0);
    const occupiedYardCapacity = yardBlocks.reduce((sum, block) => sum + (Number(block.occupiedSlots) || 0), 0);
    const availableYardCapacity = Math.max(totalYardCapacity - occupiedYardCapacity, 0);
    const occupancyRate = totalYardCapacity > 0 ? Math.round((occupiedYardCapacity / totalYardCapacity) * 10000) / 100 : 0;
    const revenue = revenueAggregate[0] || {};
    return res.json({
        success: true,
        generatedAt: now,
        period: range.period,
        range: { start: range.start, end: range.end },
        metrics: {
            containersReceived: receivedCount,
            containersReleased: releasedCount,
            currentInventory: currentInventoryBookings.length,
            availableYardCapacity,
            totalYardCapacity,
            occupiedYardCapacity,
            occupancyRate,
            revenue: roundMoney(revenue.revenue),
            revenueSubtotal: roundMoney(revenue.subtotal),
            revenueVat: roundMoney(revenue.vat),
            overstayingContainers,
        },
        bookingSummary: {
            pending: pendingBookings,
            gateOutRequested: gateOutRequests,
        },
        pendingClients,
        recentAccounts: recentAccounts.map((account) => ({
            id: String(account._id),
            name: account.companyName || account.name,
            email: account.email,
            userType: account.userType,
            role: account.role,
            status: account.status,
            createdAt: account.createdAt,
        })),
    });
};
exports.getOperationsDashboard = getOperationsDashboard;
