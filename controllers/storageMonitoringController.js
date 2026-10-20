"use strict";

// Storage Monitoring intentionally exposes three independent reads:
//   GET /storage-monitoring/containers                   paginated table ONLY
//   GET /storage-monitoring/areas                        all yard summaries ONLY
//   GET /storage-monitoring/areas/:areaId/slot-map       selected yard's 3D data ONLY
// Keep existing Inventory and Yard Setup API contracts unchanged.

const YardArea = require("../models/YardArea.js").default;
const YardBlock = require("../models/YardBlock.js").default;
const { loadStorageOccupancy } = require("../utils/storageOccupancy.js");
const { listStoredContainers, loadVisualization } = require("./storageController.js");

const API_VERSION = 6;
const AREA_FIELDS = "name code lineCount rowCount tierCount containerSize capacityTeu description isCongestionArea status color createdAt updatedAt";
const FILTER_BLOCK_FIELDS = "area name code teuSlots occupiedSlots";
const MAP_BLOCK_FIELDS = "area name code blockType bayCount rowCount tierCount containerSize teuSlots occupiedSlots x y width height rotation sortOrder status notes";
const validAreaId = (value) => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
const idOf = (value) => value == null ? "" : String(value._id || value);
const numeric = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

const toArea = (area, stats = {}) => {
    const lineCount = Math.max(1, numeric(area.lineCount, 1));
    const rowCount = Math.max(1, numeric(area.rowCount, 1));
    const tierCount = Math.max(1, numeric(area.tierCount, 1));
    const size = numeric(area.containerSize, 20);
    const capacity = numeric(area.capacityTeu);
    const totalTeuSlots = numeric(stats.totalTeuSlots);
    const occupiedSlots = numeric(stats.occupiedSlots);
    return {
        id: idOf(area._id), name: area.name, code: area.code,
        lineCount, bayCount: lineCount, rowCount, tierCount,
        containerSize: size, capacityUnit: size === 40 ? "FEU" : "TEU",
        capacityTeu: capacity, boxCount: lineCount * rowCount * tierCount,
        description: area.description || "", isCongestionArea: Boolean(area.isCongestionArea),
        status: area.status, color: area.color || "#0f766e",
        blockCount: numeric(stats.blockCount), totalTeuSlots, occupiedSlots,
        availableSlots: Math.max(totalTeuSlots - occupiedSlots, 0),
        remainingAreaCapacityTeu: Math.max(capacity - totalTeuSlots, 0),
        createdAt: area.createdAt, updatedAt: area.updatedAt,
    };
};

const toBlock = (block) => {
    const size = numeric(block.containerSize, 20);
    const teuSlots = numeric(block.teuSlots);
    const occupiedSlots = numeric(block.occupiedSlots);
    const bayCount = Math.max(1, numeric(block.bayCount, 1));
    const rowCount = Math.max(1, numeric(block.rowCount, 1));
    const tierCount = Math.max(1, numeric(block.tierCount, 1));
    return {
        id: idOf(block._id), area: idOf(block.area), name: block.name, code: block.code,
        blockType: block.blockType, bayCount, lineCount: bayCount, rowCount, tierCount,
        containerSize: size, capacityUnit: size === 40 ? "FEU" : "TEU",
        boxCount: bayCount * rowCount * tierCount, capacityTeu: teuSlots, teuSlots,
        occupiedSlots, availableSlots: Math.max(teuSlots - occupiedSlots, 0),
        utilizationPercent: teuSlots ? Math.round(occupiedSlots / teuSlots * 100) : 0,
        x: numeric(block.x), y: numeric(block.y),
        width: Math.max(60, numeric(block.width, 170)),
        height: Math.max(40, numeric(block.height, 90)),
        rotation: numeric(block.rotation), status: block.status, notes: block.notes || "",
    };
};

// Force the storage-table endpoint to remain paginated and free of 3D payloads.
// This also protects the endpoint against accidentally reintroducing the V2
// all-pages/visualization behavior through old query flags.
const listStorageContainers = (req, res) => {
    const params = req.query || {};
    if (["areaId", "blockId"].some((key) => params[key] && !validAreaId(params[key]))) {
        return res.status(400).json({ success: false, message: "Please select a valid yard area or block." });
    }
    return listStoredContainers({
        ...req,
        query: {
            ...params,
            visualizationOnly: "false",
            includeVisualization: "false",
            unpaginated: "false",
        },
    }, res);
};

const listStorageYardAreas = async (_req, res) => {
    // Three bounded queries, in parallel. No container documents are returned.
    const [areaRows, blockRows, storageOccupancy] = await Promise.all([
        YardArea.find().select(AREA_FIELDS).sort({ name: 1, _id: 1 }).lean(),
        YardBlock.find().select(FILTER_BLOCK_FIELDS).sort({ area: 1, code: 1, _id: 1 }).lean(),
        loadStorageOccupancy(),
    ]);
    const statsByArea = new Map();
    for (const block of blockRows) {
        const areaId = idOf(block.area);
        const stats = statsByArea.get(areaId) || { blockCount: 0, totalTeuSlots: 0, occupiedSlots: 0 };
        stats.blockCount += 1;
        stats.totalTeuSlots += numeric(block.teuSlots);
        stats.occupiedSlots += numeric(block.occupiedSlots);
        statsByArea.set(areaId, stats);
    }

    return res.json({
        success: true,
        storageApiVersion: API_VERSION,
        areas: areaRows.map((area) => toArea(area, statsByArea.get(idOf(area._id)))),
        // Only compact filter options are loaded upfront, not block layouts or slots.
        filterBlocks: blockRows.map((block) => ({
            id: idOf(block._id), area: idOf(block.area), name: block.name, code: block.code,
        })),
        storageOccupancy,
    });
};

const getStorageYardSlotMap = async (req, res) => {
    const { areaId } = req.params || {};
    if (!validAreaId(areaId)) {
        return res.status(400).json({ success: false, message: "Please select a valid yard area." });
    }
    const areaRow = await YardArea.findById(areaId).select(AREA_FIELDS).lean();
    if (!areaRow) {
        return res.status(404).json({ success: false, message: "Yard area not found." });
    }

    const [blockRows, visual] = await Promise.all([
        YardBlock.find({ area: areaId }).select(MAP_BLOCK_FIELDS)
            .sort({ sortOrder: 1, code: 1, _id: 1 }).lean(),
        // Full area, NOT table page 1 and NOT limited to 5,000 containers.
        // Lean projections exclude full booking/inventory documents.
        loadVisualization({ areaId, source: "all", full: true }),
    ]);
    return res.json({
        success: true,
        storageApiVersion: API_VERSION,
        area: toArea(areaRow),
        blocks: blockRows.map(toBlock),
        visualContainers: visual.visualContainers,
        visualizationTruncated: false,
    });
};

module.exports = {
    listStorageContainers,
    listStorageYardAreas,
    getStorageYardSlotMap,
    toArea,
    toBlock,
    validAreaId,
};
