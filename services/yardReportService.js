"use strict";

const mongoose = require("mongoose");
const Booking = require("../models/Booking.js").default;
const ReleaseReport = require("../models/ReleaseReport.js").default;
const User = require("../models/User.js").default;
const { yardBookingPipeline, summarizeYardBookingGroups } = require("../utils/adminMetrics.js");

const ACTIVE_YARD_STATUSES = [
  "approved_area_assigned", "gate_in_approved", "stored_in_assigned_area",
  "gate_out_requested", "gate_out_approved", "gate_out_reversal_requested",
];
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const normalize = (value) => String(value || "all").trim().toLowerCase();

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });
const validDay = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
};
const toManilaUtc = (day, endOfDay = false) => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0) - MANILA_OFFSET_MS);
};

// The exact same criteria are used for overview totals, paginated results and CSV exports.
const parseReportFilters = (raw = {}) => {
  const filters = {
    startDate: String(raw.startDate || "").trim(),
    endDate: String(raw.endDate || "").trim(),
    clientId: String(raw.clientId || "").trim(),
    loadStatus: normalize(raw.loadStatus),
    rateType: normalize(raw.rateType),
    recordSource: normalize(raw.recordSource),
  };
  for (const key of ["startDate", "endDate"]) {
    if (filters[key] && !validDay(filters[key])) throw badRequest(`${key} must be a valid date (YYYY-MM-DD).`);
  }
  if (filters.startDate && filters.endDate && filters.endDate < filters.startDate) {
    throw badRequest("End date cannot be earlier than start date.");
  }
  if (filters.clientId && !mongoose.isValidObjectId(filters.clientId)) throw badRequest("Invalid client ID.");
  for (const [key, allowed] of [
    ["loadStatus", ["all", "empty", "laden"]],
    ["rateType", ["all", "local", "international"]],
    ["recordSource", ["all", "client_booking", "admin_manual", "legacy_migration"]],
  ]) {
    if (!allowed.includes(filters[key])) throw badRequest(`Invalid ${key} filter.`);
  }
  return filters;
};

const buildReportQueries = (filters) => {
  const bookingQuery = { status: { $in: ACTIVE_YARD_STATUSES } };
  const releaseQuery = {};
  if (filters.clientId) {
    const clientId = new mongoose.Types.ObjectId(filters.clientId);
    bookingQuery.client = clientId;
    releaseQuery.client = clientId;
  }
  if (filters.loadStatus !== "all") {
    bookingQuery.containerLoadStatus = filters.loadStatus;
    releaseQuery.containerLoadStatus = filters.loadStatus;
  }
  if (filters.rateType !== "all") {
    bookingQuery.rateType = filters.rateType;
    releaseQuery.rateType = filters.rateType;
  }
  if (filters.recordSource === "client_booking") {
    const sourceCondition = { $or: [
      { recordSource: "client_booking" }, { recordSource: { $exists: false } }, { recordSource: "" },
    ] };
    bookingQuery.$and = [sourceCondition];
    releaseQuery.$and = [sourceCondition];
  } else if (filters.recordSource !== "all") {
    bookingQuery.recordSource = filters.recordSource;
    releaseQuery.recordSource = filters.recordSource;
  }
  const dateQuery = {};
  if (filters.startDate) dateQuery.$gte = toManilaUtc(filters.startDate);
  if (filters.endDate) dateQuery.$lte = toManilaUtc(filters.endDate, true);
  if (Object.keys(dateQuery).length) {
    bookingQuery.$or = [
      { inDate: dateQuery }, { storageStartDate: dateQuery },
      { assignedAt: dateQuery }, { createdAt: dateQuery },
    ];
    releaseQuery.releasedAt = dateQuery;
  }
  return { bookingQuery, releaseQuery };
};

// A release's revenue uses saved paid totals first, then stored stage payments,
// then archived booking transactions, then the historical revenue amount.
// Match the release display/getReleaseRevenue precedence without loading all
// release rows in Node or silently truncating at 1,000.
const reportRevenueAggregationStages = () => {
  const money = (field) => ({ $ifNull: [field, 0] });
  const stagePaid = { $add: [money("$gateInPaymentTotal"), money("$gateOutPaymentTotal")] };
  const archivedPaid = {
    $sum: {
      $map: {
        input: { $ifNull: [{ $arrayElemAt: ["$relatedBooking.paymentTransactions", 0] }, []] },
        as: "payment",
        in: money("$$payment.amount"),
      },
    },
  };
  return [
    { $lookup: {
      from: Booking.collection.name,
      localField: "booking",
      foreignField: "_id",
      as: "relatedBooking",
      pipeline: [{ $project: { paymentTransactions: 1 } }],
    } },
    { $addFields: {
      calculatedRevenue: { $round: [{ $cond: [
        { $gt: [money("$totalPaidAmount"), 0] }, money("$totalPaidAmount"),
        { $cond: [
          { $gt: [stagePaid, 0] }, stagePaid,
          { $cond: [{ $gt: [archivedPaid, 0] }, archivedPaid, money("$revenueTotal")] },
        ] },
      ] }, 2] },
    } },
  ];
};

const getYardOverview = async (filters) => {
  const { bookingQuery, releaseQuery } = buildReportQueries(filters);
  const [bookingGroups, releaseGroups, clientUsers] = await Promise.all([
    Booking.aggregate(yardBookingPipeline(bookingQuery)),
    ReleaseReport.aggregate([
      { $match: releaseQuery },
      ...reportRevenueAggregationStages(),
      { $group: {
        _id: "$client",
        bookingCount: { $sum: 1 },
        subtotal: { $sum: "$billingSubtotal" },
        vat: { $sum: "$vatAmount" },
        revenue: { $sum: "$calculatedRevenue" },
      } },
    ]).allowDiskUse(true),
    User.find({ userType: "client" }).select("name companyName email").sort({ companyName: 1, name: 1 }).lean(),
  ]);
  const yardSummary = summarizeYardBookingGroups(bookingGroups);
  const clientOptions = clientUsers.map((client) => ({
    id: String(client._id), name: client.companyName || client.name || client.email || "Unnamed Client",
  }));
  const names = new Map(clientOptions.map((client) => [client.id, client.name]));
  // Some historical reports have no client. Count their revenue and releases in
  // the overview but do not invent a client for the revenue ranking.
  const releasedContainers = releaseGroups.reduce((count, item) => count + item.bookingCount, 0);
  const totalRecordedRevenue = roundMoney(releaseGroups.reduce((sum, item) => sum + item.revenue, 0));
  const clientRevenue = releaseGroups.filter((item) => item._id).map((item) => {
    const clientId = String(item._id);
    return {
      clientId, clientName: names.get(clientId) || "Unknown Client",
      bookingCount: item.bookingCount,
      subtotal: roundMoney(item.subtotal),
      vat: roundMoney(item.vat),
      revenue: roundMoney(item.revenue),
    };
  }).sort((a, b) => b.revenue - a.revenue);
  return {
    ...yardSummary,
    totalTeu: Math.round(yardSummary.totalTeu * 100) / 100,
    totalFeu: Math.round(yardSummary.totalFeu * 100) / 100,
    releasedContainers, totalRecordedRevenue, clientRevenue, clientOptions,
  };
};

const parsePage = (rawPage, rawSize) => {
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return { page: number(rawPage, 1), pageSize: Math.min(number(rawSize, 10), 100) };
};

module.exports = {
  parseReportFilters, buildReportQueries, getYardOverview,
  parsePage, reportRevenueAggregationStages,
};
