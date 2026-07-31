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
const getManilaParts = (date) => {
    const manilaDate = new Date(date.getTime() + MANILA_OFFSET_MS);
    return {
        year: manilaDate.getUTCFullYear(),
        month: manilaDate.getUTCMonth(),
        day: manilaDate.getUTCDate(),
        hour: manilaDate.getUTCHours(),
    };
};
const formatBucketLabel = (date, options) => new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    ...options,
}).format(date);
const getDashboardBuckets = (range) => {
    const buckets = [];
    const nowParts = getManilaParts(range.end);
    const startParts = getManilaParts(range.start);
    if (range.period === "daily") {
        for (let hour = 0; hour <= nowParts.hour; hour += 1) {
            const start = toUtcFromManilaParts(nowParts.year, nowParts.month, nowParts.day, hour);
            const naturalEnd = toUtcFromManilaParts(nowParts.year, nowParts.month, nowParts.day, hour, 59, 59, 999);
            const end = naturalEnd > range.end ? range.end : naturalEnd;
            buckets.push({
                key: `${nowParts.year}-${nowParts.month + 1}-${nowParts.day}-${hour}`,
                label: formatBucketLabel(start, { hour: "numeric" }),
                start,
                end,
            });
        }
        return { granularity: "hour", buckets };
    }
    if (range.period === "yearly") {
        for (let month = 0; month <= nowParts.month; month += 1) {
            const start = toUtcFromManilaParts(nowParts.year, month, 1);
            const naturalEnd = toUtcFromManilaParts(nowParts.year, month + 1, 1, 0, 0, 0, 0);
            const endOfMonth = new Date(naturalEnd.getTime() - 1);
            const end = endOfMonth > range.end ? range.end : endOfMonth;
            buckets.push({
                key: `${nowParts.year}-${month + 1}`,
                label: formatBucketLabel(start, { month: "short" }),
                start,
                end,
            });
        }
        return { granularity: "month", buckets };
    }
    let cursor = toUtcFromManilaParts(startParts.year, startParts.month, startParts.day);
    while (cursor <= range.end) {
        const cursorParts = getManilaParts(cursor);
        const nextDay = toUtcFromManilaParts(cursorParts.year, cursorParts.month, cursorParts.day + 1);
        const naturalEnd = new Date(nextDay.getTime() - 1);
        const end = naturalEnd > range.end ? range.end : naturalEnd;
        buckets.push({
            key: `${cursorParts.year}-${cursorParts.month + 1}-${cursorParts.day}`,
            label: range.period === "weekly"
                ? formatBucketLabel(cursor, { weekday: "short", day: "numeric" })
                : formatBucketLabel(cursor, { month: "short", day: "numeric" }),
            start: cursor,
            end,
        });
        cursor = nextDay;
    }
    return { granularity: "day", buckets };
};
const getBookingEntryDate = (booking) => {
    const value = booking.gateInApprovedAt || booking.storageStartDate || booking.storedAt || booking.inDate;
    return value ? new Date(value) : null;
};
const getDashboardTrend = ({ range, bookings, releaseReports, totalYardCapacity }) => {
    const bucketConfig = getDashboardBuckets(range);
    const series = bucketConfig.buckets.map((bucket) => {
        let containersReceived = 0;
        let occupiedSlots = 0;
        let containersReleased = 0;
        let revenue = 0;
        for (const booking of bookings) {
            const entryAt = getBookingEntryDate(booking);
            const releasedAt = booking.releasedAt ? new Date(booking.releasedAt) : null;
            if (entryAt && entryAt >= bucket.start && entryAt <= bucket.end)
                containersReceived += 1;
            if (entryAt && entryAt <= bucket.end && (!releasedAt || releasedAt > bucket.end))
                occupiedSlots += getTeu(booking.containerSize);
        }
        for (const report of releaseReports) {
            const releasedAt = report.releasedAt ? new Date(report.releasedAt) : null;
            if (releasedAt && releasedAt >= bucket.start && releasedAt <= bucket.end) {
                containersReleased += 1;
                revenue += Number(report.revenueTotal) || 0;
            }
        }
        const occupancyRate = totalYardCapacity > 0
            ? Math.round((occupiedSlots / totalYardCapacity) * 10000) / 100
            : 0;
        return {
            key: bucket.key,
            label: bucket.label,
            start: bucket.start,
            end: bucket.end,
            containersReceived,
            containersReleased,
            occupiedSlots,
            occupancyRate,
            revenue: roundMoney(revenue),
        };
    });
    return { granularity: bucketConfig.granularity, series };
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
        containerType: report.containerType || "",
        containerLoadStatus: report.containerLoadStatus || "empty",
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
    const loadStatus = normalizeKey(req.query.loadStatus);
    const rateType = normalizeKey(req.query.rateType);
    if (req.query.clientId)
        query.client = req.query.clientId;
    if (["empty", "laden"].includes(loadStatus))
        query.containerLoadStatus = loadStatus;
    if (["local", "international"].includes(rateType))
        query.rateType = rateType;
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
    if (["empty", "laden"].includes(loadStatus))
        releaseQuery.containerLoadStatus = loadStatus;
    if (["local", "international"].includes(rateType))
        releaseQuery.rateType = rateType;
    if (dateQuery)
        releaseQuery.releasedAt = dateQuery;
    const [bookings, releaseReports, clientUsers] = await Promise.all([
        Booking_js_1.default.find(query)
            .select("client containerSize containerLoadStatus rateType status assignedArea assignedBlock inDate storageStartDate assignedAt createdAt")
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
    const local = emptySizeCounts();
    let totalTeu = 0;
    let totalFeu = 0;
    const revenueByClient = new Map();
    for (const booking of bookings) {
        const size = Number(booking.containerSize) || 20;
        const loadStatus = String(booking.containerLoadStatus || "laden").toLowerCase();
        addContainer(loadStatus === "empty" ? empty : laden, size);
        if (normalizeRateType(booking.rateType) === "international") addContainer(international, size);
        else addContainer(local, size);
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
            local,
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
    const [dashboardBookings, periodReleaseReports, currentInventoryBookings, yardBlocks, recentAccounts, pendingClients, pendingBookings, gateOutRequests] = await Promise.all([
        Booking_js_1.default.find({
            $and: [
                {
                    $or: [
                        { gateInApprovedAt: { $lte: range.end } },
                        { storageStartDate: { $lte: range.end } },
                        { storedAt: { $lte: range.end } },
                        { inDate: { $lte: range.end } },
                    ],
                },
                { $or: [{ releasedAt: null }, { releasedAt: { $gt: range.start } }] },
            ],
        }).select("containerSize gateInApprovedAt storageStartDate storedAt inDate releasedAt").lean(),
        ReleaseReport_js_1.default.find({ releasedAt: { $gte: range.start, $lte: range.end } })
            .select("releasedAt revenueTotal billingSubtotal vatAmount client")
            .populate("client", "name companyName email")
            .sort({ releasedAt: 1 })
            .lean(),
        Booking_js_1.default.find({ status: { $in: CURRENT_INVENTORY_STATUSES } })
            .select("containerNumber containerSize status rateType client")
            .lean(),
        YardBlock_js_1.default.find({ status: { $in: ["active", "full"] } }).select("teuSlots occupiedSlots").lean(),
        User_js_1.default.find().select("name email userType role status companyName createdAt").sort({ createdAt: -1 }).limit(10).lean(),
        User_js_1.default.countDocuments({ userType: "client", status: { $in: ["pending", "resubmitted"] } }),
        Booking_js_1.default.countDocuments({ status: "pending_admin_approval" }),
        Booking_js_1.default.countDocuments({ status: "gate_out_requested" }),
    ]);
    // A container is considered overstaying once its Gate-Out request has been
    // approved but the physical release has not yet been completed.
    const overstayingContainers = currentInventoryBookings.filter((booking) => booking.status === "gate_out_approved").length;
    const localContainers = currentInventoryBookings.filter((booking) => normalizeRateType(booking.rateType) === "local").length;
    const customerTotals = new Map();
    for (const report of periodReleaseReports) {
        const clientId = report.client?._id ? String(report.client._id) : String(report.client || "");
        if (!clientId) continue;
        const current = customerTotals.get(clientId) || {
            id: clientId,
            name: report.client?.companyName || report.client?.name || report.client?.email || "Unknown Client",
            transactionCount: 0,
            revenue: 0,
        };
        current.transactionCount += 1;
        current.revenue += Number(report.revenueTotal) || 0;
        customerTotals.set(clientId, current);
    }
    const topCustomer = Array.from(customerTotals.values()).sort((a, b) => b.revenue - a.revenue || b.transactionCount - a.transactionCount)[0] || null;
    const totalYardCapacity = yardBlocks.reduce((sum, block) => sum + (Number(block.teuSlots) || 0), 0);
    const occupiedYardCapacity = yardBlocks.reduce((sum, block) => sum + (Number(block.occupiedSlots) || 0), 0);
    const availableYardCapacity = Math.max(totalYardCapacity - occupiedYardCapacity, 0);
    const currentOccupancyRate = totalYardCapacity > 0 ? Math.round((occupiedYardCapacity / totalYardCapacity) * 10000) / 100 : 0;
    const trend = getDashboardTrend({ range, bookings: dashboardBookings, releaseReports: periodReleaseReports, totalYardCapacity });
    const containersReceived = trend.series.reduce((sum, point) => sum + point.containersReceived, 0);
    const containersReleased = trend.series.reduce((sum, point) => sum + point.containersReleased, 0);
    const revenue = roundMoney(trend.series.reduce((sum, point) => sum + point.revenue, 0));
    const revenueSubtotal = roundMoney(periodReleaseReports.reduce((sum, report) => sum + (Number(report.billingSubtotal) || 0), 0));
    const revenueVat = roundMoney(periodReleaseReports.reduce((sum, report) => sum + (Number(report.vatAmount) || 0), 0));
    const averageOccupancyRate = trend.series.length
        ? Math.round((trend.series.reduce((sum, point) => sum + point.occupancyRate, 0) / trend.series.length) * 100) / 100
        : 0;
    return res.json({
        success: true,
        generatedAt: now,
        period: range.period,
        range: { start: range.start, end: range.end },
        trend,
        metrics: {
            containersReceived,
            containersReleased,
            currentInventory: currentInventoryBookings.length,
            localContainers,
            availableYardCapacity,
            totalYardCapacity,
            occupiedYardCapacity,
            occupancyRate: averageOccupancyRate,
            averageOccupancyRate,
            currentOccupancyRate,
            revenue,
            revenueSubtotal,
            revenueVat,
            overstayingContainers,
            topCustomer: topCustomer ? { ...topCustomer, revenue: roundMoney(topCustomer.revenue) } : null,
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
