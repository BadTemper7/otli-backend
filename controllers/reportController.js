"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getYardContainerReport = void 0;
const Booking_js_1 = __importDefault(require("../models/Booking.js"));
const ACTIVE_YARD_STATUSES = [
    "approved_area_assigned",
    "gate_in_approved",
    "stored_in_assigned_area",
    "gate_out_requested",
    "gate_out_approved",
];
const emptySizeCounts = () => ({ 20: 0, 40: 0, 45: 0, total: 0 });
const addContainer = (bucket, size) => {
    const normalizedSize = [20, 40, 45].includes(Number(size)) ? Number(size) : 20;
    bucket[normalizedSize] += 1;
    bucket.total += 1;
};
const getTeu = (size) => {
    if (Number(size) === 40)
        return 2;
    if (Number(size) === 45)
        return 2.25;
    return 1;
};
const getFeu = (size) => {
    if (Number(size) === 20)
        return 0.5;
    if (Number(size) === 45)
        return 1.125;
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
        .select("containerSize containerLoadStatus rateType shippingLine status assignedArea assignedBlock inDate storageStartDate assignedAt createdAt")
        .lean();
    const empty = emptySizeCounts();
    const laden = emptySizeCounts();
    const international = emptySizeCounts();
    const gothong = emptySizeCounts();
    let totalTeu = 0;
    let totalFeu = 0;
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
    return res.json({
        success: true,
        generatedAt: new Date(),
        filters: {
            startDate: req.query.startDate || "",
            endDate: req.query.endDate || "",
        },
        report: {
            totalContainersInYard: bookings.length,
            empty,
            laden,
            international,
            gothong,
            totalTeu: Math.round(totalTeu * 100) / 100,
            totalFeu: Math.round(totalFeu * 100) / 100,
        },
    });
};
exports.getYardContainerReport = getYardContainerReport;
