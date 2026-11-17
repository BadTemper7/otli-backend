"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getYardModuleData = exports.getInventoryModuleData = exports.getBookingModuleData = void 0;
const bookingController = require("./bookingController.js");
const inventoryController = require("./inventoryController.js");
const yardController = require("./yardController.js");
const { loadStorageOccupancy } = require("../utils/storageOccupancy.js");
const Booking = require("../models/Booking.js").default;
const { buildAdminBookingQuery } = require("../services/adminListFilters.js");

const captureController = (handler, req) => new Promise((resolve, reject) => {
    let statusCode = 200;
    const res = {
        status(code) { statusCode = code; return this; },
        json(payload) {
            if (statusCode >= 400) {
                const error = new Error(payload?.message || `Request failed with status ${statusCode}`);
                error.statusCode = statusCode;
                error.payload = payload;
                reject(error);
                return payload;
            }
            resolve(payload || {});
            return payload;
        },
    };
    Promise.resolve(handler(req, res)).catch(reject);
});

// Shared by the dedicated tracking KPI API and the backwards-compatible
// optional filteredSummary field. Pagination never enters the aggregation.
const calculateFilteredTrackingSummary = (query = {}) => Booking.aggregate([
    { $match: buildAdminBookingQuery(query) },
    { $group: {
        _id: null, total: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ["$status", "completed_gate_out_done"] }, 1, 0] } },
        active: { $sum: { $cond: [{ $in: ["$status", ["rejected", "cancelled", "completed_gate_out_done"]] }, 0, 1] } },
    } },
]).then(([row]) => ({ total: row?.total || 0, completed: row?.completed || 0, active: row?.active || 0 }));

const getTrackingSummary = async (req, res) => {
    const summary = await calculateFilteredTrackingSummary(req.query);
    return res.json({ success: true, summary });
};
exports.getTrackingSummary = getTrackingSummary;

const getBookingModuleData = async (req, res) => {
    const summaryOnly = String(req.query?.summaryOnly || "false") === "true";
    if (summaryOnly) {
        const payload = await captureController(bookingController.getBookingSummary, req);
        return res.json({ success: true, summary: payload.summary || {} });
    }
    const includeSummary = String(req.query?.includeSummary || "true") !== "false";
    const tablePromise = captureController(bookingController.listAdminBookings, req);
    const summaryPromise = includeSummary ? captureController(bookingController.getBookingSummary, req) : Promise.resolve(null);
    // Counts for Container Tracking follow the exact same filters as its table,
    // independently of page and limit. Other booking module consumers retain
    // their existing global summary contract unless they opt in.
    const includeFilteredSummary = String(req.query?.includeFilteredSummary || "false") === "true";
    const filteredPromise = includeFilteredSummary ? calculateFilteredTrackingSummary(req.query) : Promise.resolve(null);
    const [table, summary, filteredSummary] = await Promise.all([tablePromise, summaryPromise, filteredPromise]);
    return res.json({
        success: true,
        bookings: table.bookings || [],
        pagination: table.pagination || { page: 1, currentPage: 1, limit: 10, perPage: 10, total: 0, totalPages: 1 },
        ...(includeSummary ? { summary: summary?.summary || {} } : {}),
        ...(includeFilteredSummary ? { filteredSummary } : {}),
    });
};
exports.getBookingModuleData = getBookingModuleData;

const getInventoryModuleData = async (req, res) => {
    const includeMeta = String(req.query.includeMeta || "false").toLowerCase() === "true";
    const summaryOnly = String(req.query.view || "").toLowerCase() === "storage"
        && String(req.query.summaryOnly || "false").toLowerCase() === "true";
    const includeBlocks = Boolean(req.query.areaId);
    const includeStorageOccupancy = String(req.query.view || "").toLowerCase() === "storage"
        && String(req.query.includeStorageOccupancy || "false").toLowerCase() === "true";
    const tableReq = {
        ...req,
        query: {
            ...req.query,
            // Storage Monitoring has a dedicated occupancy summary; do not
            // trigger the unrelated Inventory dashboard stats aggregation.
            includeStats: includeMeta && String(req.query.view || "").toLowerCase() !== "storage"
                ? "true" : String(req.query.includeStats || "false"),
        },
    };
    // A storage overview needs no container rows, counting/pagination or 3D payload.
    const tablePromise = summaryOnly ? Promise.resolve({}) : captureController(inventoryController.listInventoryContainers, tableReq);
    if (!includeMeta && !includeBlocks && !includeStorageOccupancy && !summaryOnly) {
        const table = await tablePromise;
        return res.json({ success: true, ...table });
    }

    const tasks = [tablePromise];
    if (includeMeta) {
        tasks.push(captureController(yardController.listYardAreas, req));
        // Storage Monitoring only needs area metadata and physical occupancy.
        // Avoid unrelated Inventory summary and client queries in this view.
        if (!summaryOnly) {
            tasks.push(captureController(yardController.getYardSummary, req));
            tasks.push(captureController(inventoryController.listInventoryClients, req));
        }
    }
    if (includeBlocks) {
        tasks.push(captureController(yardController.listYardBlocks, { ...req, params: { ...(req.params || {}), areaId: req.query.areaId } }));
    }
    if (includeStorageOccupancy) tasks.push(loadStorageOccupancy());
    const results = await Promise.all(tasks);
    const table = results[0] || {};
    let index = 1;
    let areas = null;
    let summary = null;
    let clients = null;
    let blocks = null;
    if (includeMeta) {
        areas = results[index++]?.areas || [];
        if (!summaryOnly) {
            summary = results[index++]?.summary || null;
            clients = results[index++]?.clients || [];
        }
    }
    if (includeBlocks) blocks = results[index++]?.blocks || [];
    const storageOccupancy = includeStorageOccupancy ? results[index++] : null;

    return res.json({
        success: true,
        ...(summaryOnly ? {} : {
            containers: table.containers || [],
            visualContainers: table.visualContainers || [],
            visualizationTruncated: Boolean(table.visualizationTruncated),
            pagination: table.pagination || { page: 1, currentPage: 1, limit: 10, perPage: 10, total: 0, totalPages: 1 },
            stats: table.stats,
            truncated: Boolean(table.truncated),
        }),
        ...(includeMeta ? (summaryOnly ? { areas } : { areas, summary, clients }) : {}),
        ...(includeBlocks ? { blocks } : {}),
        ...(includeStorageOccupancy ? { storageOccupancy, storageApiVersion: 5 } : {}),
    });
};
exports.getInventoryModuleData = getInventoryModuleData;

const getYardModuleData = async (req, res) => {
    const [areasResult, summaryResult] = await Promise.all([
        captureController(yardController.listYardAreas, req),
        captureController(yardController.getYardSummary, req),
    ]);
    return res.json({
        success: true,
        areas: areasResult.areas || [],
        summary: summaryResult.summary || {
            areaCount: 0,
            totalAreaCapacityTeu: 0,
            totalAreaCapacityFeu: 0,
            totalBoxes: 0,
            blockCount: 0,
        },
    });
};
exports.getYardModuleData = getYardModuleData;
