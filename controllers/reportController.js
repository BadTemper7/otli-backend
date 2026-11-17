"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOperationsDashboard = exports.getYardContainerReport = void 0;
const Booking_js_1 = __importDefault(require("../models/Booking.js"));
const { yardBookingPipeline, summarizeYardBookingGroups } = require("../utils/adminMetrics.js");
const User_js_1 = __importDefault(require("../models/User.js"));
const YardBlock_js_1 = __importDefault(require("../models/YardBlock.js"));
const ReleaseReport_js_1 = __importDefault(require("../models/ReleaseReport.js"));
const { parseReportFilters, buildReportQueries, getYardOverview, parsePage } = require("../services/yardReportService.js");
const { csvLine } = require("../utils/reportCsv.js");
const { getDashboardRange, getDashboardBuckets } = require("../utils/dashboardDateRange.js");
const CURRENT_INVENTORY_STATUSES = [
    "gate_in_approved",
    "stored_in_assigned_area",
    "gate_out_requested",
    "gate_out_approved",
    "gate_out_reversal_requested",
];
const getTeu = (size) => Number(size) === 40 ? 2 : 1;
const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const getReleaseRevenue = (report = {}) => {
    const storedPaidTotal = Number(report.totalPaidAmount) || 0;
    if (storedPaidTotal > 0)
        return roundMoney(storedPaidTotal);
    const storedStagePayments = (Number(report.gateInPaymentTotal) || 0) + (Number(report.gateOutPaymentTotal) || 0);
    if (storedStagePayments > 0)
        return roundMoney(storedStagePayments);
    const transactions = Array.isArray(report.booking?.paymentTransactions) ? report.booking.paymentTransactions : [];
    const archivedPayments = transactions.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
    if (archivedPayments > 0)
        return roundMoney(archivedPayments);
    // Historical release reports created before payment totals were stored fall back
    // to the previous revenue value so existing dashboards do not lose old data.
    return roundMoney(report.revenueTotal);
};
const normalizeRateType = (value) => String(value || "").toLowerCase() === "international" ? "international" : "local";
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
                revenue += getReleaseRevenue(report);
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
    const booking = report.booking || {};
    const transactions = Array.isArray(booking.paymentTransactions) ? booking.paymentTransactions : [];
    const gateInPaymentTotal = roundMoney(Number(report.gateInPaymentTotal) || transactions.filter((item) => item.paymentStage === "gate_in").reduce((sum, item) => sum + (Number(item.amount) || 0), 0));
    const gateOutPaymentTotal = roundMoney(Number(report.gateOutPaymentTotal) || transactions.filter((item) => item.paymentStage === "gate_out").reduce((sum, item) => sum + (Number(item.amount) || 0), 0));
    const gateInBillingTransactions = transactions.filter((item) => item.paymentStage === "gate_in");
    const gateInBillingTotal = roundMoney(Number(report.gateInBillingTotal) || Math.max(...gateInBillingTransactions.map((item) => Number(item.grossTotal) || Number(item.amount) || 0), 0));
    const gateOutBillingTotal = roundMoney(Number(report.gateOutBillingTotal) || Number(booking.billingTotal) || Number(report.revenueTotal || 0) - gateInBillingTotal);
    const totalBillingAmount = roundMoney(Number(report.totalBillingAmount) || gateInBillingTotal + gateOutBillingTotal);
    const totalPaidAmount = roundMoney(Number(report.totalPaidAmount) || gateInPaymentTotal + gateOutPaymentTotal || getReleaseRevenue(report));
    return {
        id: String(report._id),
        reportNumber: report.reportNumber,
        booking: report.booking ? String(report.booking?._id || report.booking) : "",
        bookingReference: report.bookingReference,
        bookingNumber: report.bookingNumber || "",
        recordSource: report.recordSource || "client_booking",
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
        gateInBillingTotal,
        gateInPaymentTotal,
        gateOutBillingTotal,
        gateOutPaymentTotal,
        totalBillingAmount,
        totalPaidAmount,
        revenueTotal: totalPaidAmount,
        paymentReferenceNumber: report.paymentReferenceNumber || "",
        generatedAt: report.generatedAt,
    };
};
// Reports overview is computed across ALL matching MongoDB records. Only the
// release-history table is paginated; overview and client ranking are never
// derived from the current page.
const getReportsOverview = async (req, res) => {
    const filters = parseReportFilters(req.query);
    const report = await getYardOverview(filters);
    return res.json({ success: true, generatedAt: new Date(), filters, report });
};
exports.getReportsOverview = getReportsOverview;

const fetchReleasePage = async (filters, pageArg, sizeArg) => {
    const { releaseQuery } = buildReportQueries(filters);
    const { page: requestedPage, pageSize } = parsePage(pageArg, sizeArg);
    const totalItems = await ReleaseReport_js_1.default.countDocuments(releaseQuery);
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const results = await ReleaseReport_js_1.default.find(releaseQuery)
        .populate("client", "name companyName email")
        .populate("booking", "paymentTransactions billingTotal")
        .sort({ releasedAt: -1, generatedAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean();
    return {
        items: results.map(safeReleaseReport),
        pagination: { page, pageSize, totalItems, totalPages },
    };
};

const getReportsReleases = async (req, res) => {
    const filters = parseReportFilters(req.query);
    const pageResult = await fetchReleasePage(filters, req.query.page, req.query.pageSize);
    return res.json({ success: true, filters, ...pageResult });
};
exports.getReportsReleases = getReportsReleases;

// Backward-compatible endpoint for integrations still using yard-containers.
// Its array is explicitly a page, never a disguised "all records" response.
const getYardContainerReport = async (req, res) => {
    const filters = parseReportFilters(req.query);
    const [report, releases] = await Promise.all([
        getYardOverview(filters), fetchReleasePage(filters, req.query.page, req.query.pageSize),
    ]);
    return res.json({
        success: true, generatedAt: new Date(), filters,
        report: { ...report, releaseReports: releases.items, releasePagination: releases.pagination },
    });
};
exports.getYardContainerReport = getYardContainerReport;

const reportTime = (value) => {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("en-PH", {
        timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short",
    }).format(date);
};

const overviewRows = (report) => [
    ["Containers in Yard", report.totalContainersInYard],
    ["Legacy Records", report.legacyContainers],
    ["Empty Containers", report.empty.total],
    ["Laden Containers", report.laden.total],
    ["Local Containers", report.local.total],
    ["International Containers", report.international.total],
    ["Completed Releases", report.releasedContainers],
    ["Recorded Revenue (PHP)", report.totalRecordedRevenue],
];
const breakdownRows = (report) => [
    ...["empty", "laden", "local", "international"].flatMap((kind) => [
        [kind, "20 FT", report[kind][20]], [kind, "40 FT", report[kind][40]],
        [kind, "Total", report[kind].total],
    ]),
];

const writeCsv = async (res, row) => {
    if (res.destroyed || res.writableEnded) return false;
    if (!res.write(csvLine(row))) {
        await new Promise((resolve) => {
            const finish = () => {
                res.off("drain", finish);
                res.off("close", finish);
                resolve();
            };
            res.once("drain", finish);
            res.once("close", finish);
        });
    }
    return !res.destroyed && !res.writableEnded;
};

// CSV is streamed from a database cursor with the same filters as the table.
// It does not use the table's page/limit or its in-memory rendered rows.
const exportReportsCsv = async (req, res) => {
    const filters = parseReportFilters(req.query);
    const section = String(req.query.section || "all").toLowerCase();
    if (!["all", "overview", "containers", "revenue", "releases", "capacity"].includes(section)) {
        const error = new Error("Invalid report export section.");
        error.statusCode = 400;
        throw error;
    }
    const include = (name) => section === "all" || section === name;
    // Complete the database query before sending headers so failures can still
    // be reported as JSON API errors rather than incomplete CSV downloads.
    const report = section === "releases" ? null : await getYardOverview(filters);
    const { releaseQuery } = buildReportQueries(filters);
    const now = new Date();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="yard-report-${section}-${now.toISOString().slice(0, 10)}.csv"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (row) => writeCsv(res, row);
    try {
        await send(["OneTrue Yard Container Report"]);
        await send(["Generated (PH time)", reportTime(now)]);
        await send(["Content", section]);
        await send(["Date From", filters.startDate || "All"]);
        await send(["Date To", filters.endDate || "All"]);
        await send(["Client ID", filters.clientId || "All Clients"]);
        await send(["Container Load", filters.loadStatus]);
        await send(["Rate Classification", filters.rateType]);
        await send(["Record Source", filters.recordSource]);
        if (include("overview")) {
            await send([]);
            await send(["Overview Metric", "Total Across All Filtered Records"]);
            for (const row of overviewRows(report)) await send(row);
        }
        if (include("containers")) {
            await send([]);
            await send(["Container Classification", "Size", "Count"]);
            for (const row of breakdownRows(report)) await send(row);
        }
        if (include("capacity")) {
            await send([]);
            await send(["Capacity Equivalent", "Quantity"]);
            await send(["TEU", report.totalTeu]);
            await send(["FEU", report.totalFeu]);
        }
        if (include("revenue")) {
            await send([]);
            await send(["Client", "Completed Releases", "Subtotal (PHP)", "VAT (PHP)", "Revenue (PHP)"]);
            for (const item of report.clientRevenue) {
                if (!await send([item.clientName, item.bookingCount, item.subtotal, item.vat, item.revenue])) break;
            }
        }
        if (include("releases") && !res.destroyed) {
            await send([]);
            await send(["Release Report", "Client", "Container", "Size (FT)", "Record Source", "Load Status", "Classification", "Released At (PH)", "Billing Days", "Gate-In Payment (PHP)", "Gate-Out Payment (PHP)", "Total Billing (PHP)", "Subtotal (PHP)", "VAT (PHP)", "Revenue (PHP)"]);
            const cursor = ReleaseReport_js_1.default.find(releaseQuery)
                .populate("client", "name companyName email")
                .populate("booking", "paymentTransactions billingTotal")
                .sort({ releasedAt: -1, generatedAt: -1, _id: -1 })
                .lean().cursor({ batchSize: 100 });
            try {
                for await (const raw of cursor) {
                    if (res.destroyed) break;
                    const item = safeReleaseReport(raw);
                    const written = await send([
                        item.reportNumber, item.clientName, item.containerNumber, item.containerSize,
                        item.recordSource, item.containerLoadStatus, item.rateType, reportTime(item.releasedAt),
                        item.billingDays, item.gateInPaymentTotal, item.gateOutPaymentTotal,
                        item.totalBillingAmount, item.billingSubtotal, item.vatAmount, item.revenueTotal,
                    ]);
                    if (!written) break;
                }
            } finally {
                await cursor.close();
            }
        }
        if (!res.destroyed) res.end();
    } catch (error) {
        if (res.headersSent) {
            res.destroy(error);
            return;
        }
        throw error;
    }
};
exports.exportReportsCsv = exportReportsCsv;

const getOperationsDashboard = async (req, res) => {
    const now = new Date();
    let range;
    try {
        range = getDashboardRange(req.query.period, now, req.query.startDate, req.query.endDate);
    } catch (error) {
        if (error instanceof RangeError) return res.status(400).json({ success: false, message: error.message });
        throw error;
    }
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
            .select("releasedAt revenueTotal totalPaidAmount gateInPaymentTotal gateOutPaymentTotal billingSubtotal vatAmount client booking")
            .populate("client", "name companyName email")
            .populate("booking", "paymentTransactions")
            .sort({ releasedAt: 1 })
            .lean(),
        Booking_js_1.default.find({ status: { $in: CURRENT_INVENTORY_STATUSES } })
            .select("containerNumber containerSize status rateType client outDate releasedAt gateOutGracePeriodMinutes")
            .lean(),
        YardBlock_js_1.default.find({ status: { $in: ["active", "full"] } }).select("teuSlots occupiedSlots").lean(),
        User_js_1.default.find().select("name email userType role status companyName createdAt").sort({ createdAt: -1 }).limit(10).lean(),
        User_js_1.default.countDocuments({ userType: "client", status: { $in: ["pending", "resubmitted"] } }),
        Booking_js_1.default.countDocuments({ status: "pending_admin_approval" }),
        Booking_js_1.default.countDocuments({ status: "gate_out_requested" }),
    ]);
    const dashboardNow = new Date();
    const defaultGraceMinutes = Math.max(Number(process.env.GATE_OUT_GRACE_PERIOD_MINUTES ?? 120) || 0, 0);
    const overstayingContainers = currentInventoryBookings.filter((booking) => {
        if (!["gate_out_approved", "gate_out_reversal_requested"].includes(booking.status) || booking.releasedAt || !booking.outDate)
            return false;
        const scheduledAt = new Date(booking.outDate);
        if (Number.isNaN(scheduledAt.getTime()))
            return false;
        const graceMinutes = Math.max(Number(booking.gateOutGracePeriodMinutes ?? defaultGraceMinutes) || 0, 0);
        return dashboardNow.getTime() > scheduledAt.getTime() + graceMinutes * 60 * 1000;
    }).length;
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
        current.revenue += getReleaseRevenue(report);
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
