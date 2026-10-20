"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getYardModuleData = exports.getInventoryModuleData = exports.getBookingModuleData = void 0;
const bookingController = require("./bookingController.js");
const inventoryController = require("./inventoryController.js");
const yardController = require("./yardController.js");
const { loadStorageOccupancy } = require("../utils/storageOccupancy.js");

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

const getBookingModuleData = async (req, res) => {
    const [table, summary] = await Promise.all([
        captureController(bookingController.listAdminBookings, req),
        captureController(bookingController.getBookingSummary, req),
    ]);
    return res.json({
        success: true,
        bookings: table.bookings || [],
        pagination: table.pagination || { page: 1, currentPage: 1, limit: 10, perPage: 10, total: 0, totalPages: 1 },
        summary: summary.summary || {},
    });
};
exports.getBookingModuleData = getBookingModuleData;

const getInventoryModuleData = async (req, res) => {
    const includeMeta = String(req.query.includeMeta || "false").toLowerCase() === "true";
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
    const tablePromise = captureController(inventoryController.listInventoryContainers, tableReq);
    if (!includeMeta && !includeBlocks && !includeStorageOccupancy) {
        const table = await tablePromise;
        return res.json({ success: true, ...table });
    }

    const tasks = [tablePromise];
    if (includeMeta) {
        tasks.push(captureController(yardController.listYardAreas, req));
        tasks.push(captureController(yardController.getYardSummary, req));
        tasks.push(captureController(inventoryController.listInventoryClients, req));
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
        summary = results[index++]?.summary || null;
        clients = results[index++]?.clients || [];
    }
    if (includeBlocks) blocks = results[index++]?.blocks || [];
    const storageOccupancy = includeStorageOccupancy ? results[index++] : null;

    return res.json({
        success: true,
        containers: table.containers || [],
        visualContainers: table.visualContainers || [],
        visualizationTruncated: Boolean(table.visualizationTruncated),
        pagination: table.pagination || { page: 1, currentPage: 1, limit: 10, perPage: 10, total: 0, totalPages: 1 },
        stats: table.stats,
        truncated: Boolean(table.truncated),
        ...(includeMeta ? { areas, summary, clients } : {}),
        ...(includeBlocks ? { blocks } : {}),
        ...(includeStorageOccupancy ? { storageOccupancy } : {}),
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
