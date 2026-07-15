"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteYardBlock = exports.updateYardBlock = exports.createYardBlock = exports.listYardBlocks = exports.deleteYardArea = exports.updateYardArea = exports.createYardArea = exports.listApprovalYardBlocks = exports.listYardAreas = exports.getYardSummary = void 0;
const YardArea_js_1 = __importDefault(require("../models/YardArea.js"));
const YardBlock_js_1 = __importDefault(require("../models/YardBlock.js"));
const socket_js_1 = require("../socket/socket.js");
const toNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};
const toPositiveNumber = (value, fallback = 1) => {
    return Math.max(toNumber(value, fallback), 1);
};
const toContainerSize = (value, fallback = 20) => {
    const size = Number(value);
    return [20, 40, 45].includes(size) ? size : fallback;
};
const getContainerTeuFactor = (size) => {
    if (Number(size) === 40)
        return 2;
    if (Number(size) === 45)
        return 3;
    return 1;
};
const calculateCapacityTeu = ({ lineCount = 1, rowCount = 1, tierCount = 1, containerSize = 20 }) => {
    const capacity = toPositiveNumber(lineCount, 1) * toPositiveNumber(rowCount, 1) * toPositiveNumber(tierCount, 1) * getContainerTeuFactor(containerSize);
    return Math.max(Math.round(capacity * 100) / 100, 1);
};
const buildAreaCode = (name = "AREA") => {
    const base = String(name)
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 16);
    return base || `AREA-${Date.now()}`;
};
const makeUniqueAreaCode = async (name, excludeId = null) => {
    const base = buildAreaCode(name);
    let code = base;
    let count = 2;
    while (await YardArea_js_1.default.findOne({ code, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })) {
        code = `${base}-${count}`;
        count += 1;
    }
    return code;
};
const safeArea = (area, blockStats = null) => {
    const doc = area.toObject ? area.toObject() : area;
    const capacityTeu = Number(doc.capacityTeu) || 0;
    const totalBlockTeuSlots = Number(blockStats?.totalTeuSlots ?? doc.totalTeuSlots ?? 0) || 0;
    const occupiedSlots = Number(blockStats?.occupiedSlots ?? doc.occupiedSlots ?? 0) || 0;
    return {
        id: String(doc._id),
        name: doc.name,
        code: doc.code,
        lineCount: Number(doc.lineCount) || 1,
        rowCount: Number(doc.rowCount) || 1,
        tierCount: Number(doc.tierCount) || 1,
        containerSize: Number(doc.containerSize) || 20,
        capacityTeu,
        description: doc.description || "",
        status: doc.status,
        color: doc.color || "#0f766e",
        sortOrder: doc.sortOrder || 0,
        blockCount: blockStats?.blockCount ?? doc.blockCount ?? 0,
        totalTeuSlots: totalBlockTeuSlots,
        occupiedSlots,
        availableSlots: Math.max(totalBlockTeuSlots - occupiedSlots, 0),
        remainingAreaCapacityTeu: Math.max(capacityTeu - totalBlockTeuSlots, 0),
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
};
const safeBlock = (block) => {
    const doc = block.toObject ? block.toObject() : block;
    const teuSlots = Number(doc.teuSlots) || 0;
    const occupiedSlots = Number(doc.occupiedSlots) || 0;
    return {
        id: String(doc._id),
        area: doc.area?._id ? String(doc.area._id) : String(doc.area),
        areaName: doc.area?.name || "",
        areaCode: doc.area?.code || "",
        name: doc.name,
        code: doc.code,
        blockType: doc.blockType,
        lineCount: Number(doc.bayCount) || 1,
        bayCount: Number(doc.bayCount) || 1,
        rowCount: Number(doc.rowCount) || 1,
        tierCount: Number(doc.tierCount) || 1,
        containerSize: Number(doc.containerSize) || 20,
        capacityTeu: teuSlots,
        teuSlots,
        x: Number(doc.x) || 0,
        y: Number(doc.y) || 0,
        width: Math.max(Number(doc.width) || 170, 60),
        height: Math.max(Number(doc.height) || 90, 40),
        rotation: Number(doc.rotation) || 0,
        sortOrder: Number(doc.sortOrder) || 0,
        occupiedSlots,
        availableSlots: Math.max(teuSlots - occupiedSlots, 0),
        utilizationPercent: teuSlots > 0 ? Math.round((occupiedSlots / teuSlots) * 100) : 0,
        status: doc.status,
        notes: doc.notes || "",
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
};
const createDefaultBlockForArea = async (area) => {
    const existingBlock = await YardBlock_js_1.default.findOne({ area: area._id });
    if (existingBlock)
        return existingBlock;
    const lineValue = toPositiveNumber(area.lineCount, 1);
    const rowValue = toPositiveNumber(area.rowCount, 1);
    const tierValue = toPositiveNumber(area.tierCount, 1);
    const size = toContainerSize(area.containerSize, 20);
    const computedCapacity = calculateCapacityTeu({ lineCount: lineValue, rowCount: rowValue, tierCount: tierValue, containerSize: size });
    const block = await YardBlock_js_1.default.create({
        area: area._id,
        name: area.name,
        code: area.code,
        blockType: "standard",
        bayCount: lineValue,
        rowCount: rowValue,
        tierCount: tierValue,
        containerSize: size,
        teuSlots: area.capacityTeu ? toPositiveNumber(area.capacityTeu, computedCapacity) : computedCapacity,
        occupiedSlots: 0,
        status: area.status === "active" ? "active" : area.status === "maintenance" ? "maintenance" : "inactive",
        notes: "Internal location record created from the yard area for approval and slot tracking.",
    });
    await block.populate("area", "name code");
    const payload = safeBlock(block);
    (0, socket_js_1.emitToAdmins)("inventory:block_created", payload);
    (0, socket_js_1.emitToAdmins)("yard:block_created", payload);
    return block;
};
const syncDefaultBlockWithArea = async (area) => {
    const block = await YardBlock_js_1.default.findOne({
        area: area._id,
        notes: /(Default block created automatically from the yard area|Internal location record created from the yard area)/i,
    });
    if (!block)
        return null;
    const lineValue = toPositiveNumber(area.lineCount, 1);
    const rowValue = toPositiveNumber(area.rowCount, 1);
    const tierValue = toPositiveNumber(area.tierCount, 1);
    const size = toContainerSize(area.containerSize, 20);
    const computedCapacity = calculateCapacityTeu({ lineCount: lineValue, rowCount: rowValue, tierCount: tierValue, containerSize: size });
    block.name = area.name;
    block.code = area.code;
    block.bayCount = lineValue;
    block.rowCount = rowValue;
    block.tierCount = tierValue;
    block.containerSize = size;
    block.teuSlots = area.capacityTeu ? toPositiveNumber(area.capacityTeu, computedCapacity) : computedCapacity;
    block.status = area.status === "active" ? "active" : area.status === "maintenance" ? "maintenance" : "inactive";
    await block.save();
    await block.populate("area", "name code");
    const payload = safeBlock(block);
    (0, socket_js_1.emitToAdmins)("inventory:block_updated", payload);
    (0, socket_js_1.emitToAdmins)("yard:block_updated", payload);
    return block;
};
const loadAreaStats = async () => {
    const stats = await YardBlock_js_1.default.aggregate([
        {
            $group: {
                _id: "$area",
                blockCount: { $sum: 1 },
                totalTeuSlots: { $sum: "$teuSlots" },
                occupiedSlots: { $sum: "$occupiedSlots" },
            },
        },
    ]);
    return stats.reduce((acc, stat) => {
        acc[String(stat._id)] = stat;
        return acc;
    }, {});
};
const getYardSummary = async (req, res) => {
    const [areaCount, blockCount, areaTotals, blockTotals] = await Promise.all([
        YardArea_js_1.default.countDocuments(),
        YardBlock_js_1.default.countDocuments(),
        YardArea_js_1.default.aggregate([
            {
                $group: {
                    _id: null,
                    totalAreaCapacityTeu: { $sum: "$capacityTeu" },
                },
            },
        ]),
        YardBlock_js_1.default.aggregate([
            {
                $group: {
                    _id: null,
                    totalTeuSlots: { $sum: "$teuSlots" },
                    occupiedSlots: { $sum: "$occupiedSlots" },
                },
            },
        ]),
    ]);
    const areaCapacity = areaTotals[0]?.totalAreaCapacityTeu || 0;
    const totals = blockTotals[0] || { totalTeuSlots: 0, occupiedSlots: 0 };
    return res.json({
        success: true,
        summary: {
            areaCount,
            blockCount,
            totalAreaCapacityTeu: areaCapacity,
            totalTeuSlots: totals.totalTeuSlots || 0,
            occupiedSlots: totals.occupiedSlots || 0,
            availableSlots: Math.max((totals.totalTeuSlots || 0) - (totals.occupiedSlots || 0), 0),
            remainingAreaCapacityTeu: Math.max(areaCapacity - (totals.totalTeuSlots || 0), 0),
        },
    });
};
exports.getYardSummary = getYardSummary;
const listYardAreas = async (req, res) => {
    const areas = await YardArea_js_1.default.find().sort({ sortOrder: 1, name: 1 });
    const statsByArea = await loadAreaStats();
    return res.json({
        success: true,
        areas: areas.map((area) => safeArea(area, statsByArea[String(area._id)])),
    });
};
exports.listYardAreas = listYardAreas;
const listApprovalYardBlocks = async (req, res) => {
    const areas = await YardArea_js_1.default.find().sort({ sortOrder: 1, name: 1 });
    const areaLocations = [];
    for (const area of areas) {
        await syncDefaultBlockWithArea(area);
        let areaLocation = await YardBlock_js_1.default.findOne({ area: area._id })
            .populate("area", "name code")
            .sort({ sortOrder: 1, code: 1, name: 1 });
        if (!areaLocation) {
            areaLocation = await createDefaultBlockForArea(area);
            await areaLocation.populate("area", "name code");
        }
        areaLocations.push(areaLocation);
    }
    const statsByArea = await loadAreaStats();
    return res.json({
        success: true,
        areas: areas.map((area) => safeArea(area, statsByArea[String(area._id)])),
        blocks: areaLocations.map(safeBlock),
    });
};
exports.listApprovalYardBlocks = listApprovalYardBlocks;
const createYardArea = async (req, res) => {
    const { name, lineCount, rowCount, tierCount, containerSize, capacityTeu, description, status, color, sortOrder, code } = req.body;
    if (!name) {
        return res.status(400).json({ success: false, message: "Area name is required." });
    }
    const size = toContainerSize(containerSize, 20);
    const lineValue = toPositiveNumber(lineCount, 1);
    const rowValue = toPositiveNumber(rowCount, 1);
    const tierValue = toPositiveNumber(tierCount, 1);
    const computedCapacity = calculateCapacityTeu({ lineCount: lineValue, rowCount: rowValue, tierCount: tierValue, containerSize: size });
    const areaCode = code ? String(code).toUpperCase().trim() : await makeUniqueAreaCode(name);
    const exists = await YardArea_js_1.default.findOne({ code: areaCode });
    if (exists) {
        return res.status(409).json({ success: false, message: "Area code already exists." });
    }
    const area = await YardArea_js_1.default.create({
        name,
        code: areaCode,
        lineCount: lineValue,
        rowCount: rowValue,
        tierCount: tierValue,
        containerSize: size,
        capacityTeu: capacityTeu ? toPositiveNumber(capacityTeu, computedCapacity) : computedCapacity,
        description,
        status: status || "active",
        color: color || "#0f766e",
        sortOrder: toNumber(sortOrder, 0),
    });
    await createDefaultBlockForArea(area);
    const payload = safeArea(area);
    (0, socket_js_1.emitToAdmins)("yard:area_created", payload);
    return res.status(201).json({ success: true, message: "Yard area created successfully.", area: payload });
};
exports.createYardArea = createYardArea;
const updateYardArea = async (req, res) => {
    const area = await YardArea_js_1.default.findById(req.params.id);
    if (!area) {
        return res.status(404).json({ success: false, message: "Yard area not found." });
    }
    const { name, code, lineCount, rowCount, tierCount, containerSize, capacityTeu, description, status, color, sortOrder } = req.body;
    if (code) {
        const normalizedCode = String(code).toUpperCase().trim();
        const exists = await YardArea_js_1.default.findOne({ code: normalizedCode, _id: { $ne: area._id } });
        if (exists) {
            return res.status(409).json({ success: false, message: "Area code already exists." });
        }
        area.code = normalizedCode;
    }
    area.name = name ?? area.name;
    area.lineCount = lineCount === undefined ? area.lineCount : toPositiveNumber(lineCount, area.lineCount);
    area.rowCount = rowCount === undefined ? area.rowCount : toPositiveNumber(rowCount, area.rowCount);
    area.tierCount = tierCount === undefined ? area.tierCount : toPositiveNumber(tierCount, area.tierCount);
    area.containerSize = containerSize === undefined ? area.containerSize : toContainerSize(containerSize, area.containerSize);
    const computedCapacity = calculateCapacityTeu({
        lineCount: area.lineCount,
        rowCount: area.rowCount,
        tierCount: area.tierCount,
        containerSize: area.containerSize,
    });
    area.capacityTeu = capacityTeu === undefined ? area.capacityTeu : toPositiveNumber(capacityTeu, computedCapacity);
    area.description = description ?? area.description;
    area.status = status ?? area.status;
    area.color = color ?? area.color;
    area.sortOrder = sortOrder === undefined ? area.sortOrder : toNumber(sortOrder, area.sortOrder);
    await area.save();
    await syncDefaultBlockWithArea(area);
    const payload = safeArea(area);
    (0, socket_js_1.emitToAdmins)("yard:area_updated", payload);
    return res.json({ success: true, message: "Yard area updated successfully.", area: payload });
};
exports.updateYardArea = updateYardArea;
const deleteYardArea = async (req, res) => {
    const area = await YardArea_js_1.default.findById(req.params.id);
    if (!area) {
        return res.status(404).json({ success: false, message: "Yard area not found." });
    }
    const blockCount = await YardBlock_js_1.default.countDocuments({ area: area._id });
    if (blockCount > 0 && req.query.force !== "true") {
        return res.status(400).json({
            success: false,
            message: "This area still has inventory blocks. Delete the blocks first or send force=true.",
        });
    }
    if (blockCount > 0) {
        await YardBlock_js_1.default.deleteMany({ area: area._id });
    }
    await YardArea_js_1.default.deleteOne({ _id: area._id });
    (0, socket_js_1.emitToAdmins)("yard:area_deleted", { id: String(area._id), blockCount });
    return res.json({ success: true, message: "Yard area deleted successfully." });
};
exports.deleteYardArea = deleteYardArea;
const listYardBlocks = async (req, res) => {
    const area = await YardArea_js_1.default.findById(req.params.areaId);
    if (!area) {
        return res.status(404).json({ success: false, message: "Yard area not found." });
    }
    let blocks = await YardBlock_js_1.default.find({ area: area._id }).populate("area", "name code").sort({ sortOrder: 1, code: 1, name: 1 });
    if (blocks.length === 0) {
        const defaultBlock = await createDefaultBlockForArea(area);
        blocks = [defaultBlock];
    }
    return res.json({
        success: true,
        area: safeArea(area),
        blocks: blocks.map(safeBlock),
    });
};
exports.listYardBlocks = listYardBlocks;
const createYardBlock = async (req, res) => {
    const area = await YardArea_js_1.default.findById(req.params.areaId);
    if (!area) {
        return res.status(404).json({ success: false, message: "Yard area not found." });
    }
    const { name, code, blockType, lineCount, bayCount, rowCount, tierCount, containerSize, capacityTeu, teuSlots, occupiedSlots, x, y, width, height, rotation, sortOrder, status, notes, } = req.body;
    if (!name || !code) {
        return res.status(400).json({ success: false, message: "Container block name and code are required." });
    }
    const normalizedCode = String(code).toUpperCase().trim();
    const exists = await YardBlock_js_1.default.findOne({ area: area._id, code: normalizedCode });
    if (exists) {
        return res.status(409).json({ success: false, message: "Block code already exists in this area." });
    }
    const size = toContainerSize(containerSize, area.containerSize || 20);
    const lineValue = toPositiveNumber(lineCount ?? bayCount, area.lineCount || 1);
    const rowValue = toPositiveNumber(rowCount, area.rowCount || 1);
    const tierValue = toPositiveNumber(tierCount, area.tierCount || 1);
    const computedCapacity = calculateCapacityTeu({ lineCount: lineValue, rowCount: rowValue, tierCount: tierValue, containerSize: size });
    const capacity = toPositiveNumber(capacityTeu ?? teuSlots, computedCapacity);
    const block = await YardBlock_js_1.default.create({
        area: area._id,
        name,
        code: normalizedCode,
        blockType: blockType || "standard",
        bayCount: lineValue,
        rowCount: rowValue,
        tierCount: tierValue,
        containerSize: size,
        teuSlots: capacity,
        occupiedSlots: Math.min(Math.max(toNumber(occupiedSlots, 0), 0), capacity),
        x: Math.max(toNumber(x, 40), 0),
        y: Math.max(toNumber(y, 40), 0),
        width: Math.max(toNumber(width, 170), 60),
        height: Math.max(toNumber(height, 90), 40),
        rotation: toNumber(rotation, 0),
        sortOrder: toNumber(sortOrder, 0),
        status: status || "active",
        notes,
    });
    await block.populate("area", "name code");
    const payload = safeBlock(block);
    (0, socket_js_1.emitToAdmins)("inventory:block_created", payload);
    (0, socket_js_1.emitToAdmins)("yard:block_created", payload);
    return res.status(201).json({ success: true, message: "Inventory block created successfully.", block: payload });
};
exports.createYardBlock = createYardBlock;
const updateYardBlock = async (req, res) => {
    const block = await YardBlock_js_1.default.findById(req.params.id);
    if (!block) {
        return res.status(404).json({ success: false, message: "Inventory block not found." });
    }
    const area = await YardArea_js_1.default.findById(block.area);
    const { name, code, blockType, lineCount, bayCount, rowCount, tierCount, containerSize, capacityTeu, teuSlots, occupiedSlots, x, y, width, height, rotation, sortOrder, status, notes, } = req.body;
    if (code) {
        const normalizedCode = String(code).toUpperCase().trim();
        const exists = await YardBlock_js_1.default.findOne({ area: block.area, code: normalizedCode, _id: { $ne: block._id } });
        if (exists) {
            return res.status(409).json({ success: false, message: "Block code already exists in this area." });
        }
        block.code = normalizedCode;
    }
    block.name = name ?? block.name;
    block.blockType = blockType ?? block.blockType;
    block.bayCount = lineCount === undefined && bayCount === undefined ? block.bayCount : toPositiveNumber(lineCount ?? bayCount, block.bayCount);
    block.rowCount = rowCount === undefined ? block.rowCount : toPositiveNumber(rowCount, block.rowCount);
    block.tierCount = tierCount === undefined ? block.tierCount : toPositiveNumber(tierCount, block.tierCount);
    block.containerSize = containerSize === undefined ? block.containerSize : toContainerSize(containerSize, area?.containerSize || block.containerSize);
    const fallbackCapacity = calculateCapacityTeu({
        lineCount: block.bayCount,
        rowCount: block.rowCount,
        tierCount: block.tierCount,
        containerSize: block.containerSize,
    });
    block.teuSlots = capacityTeu === undefined && teuSlots === undefined ? Math.max(block.teuSlots, 1) : toPositiveNumber(capacityTeu ?? teuSlots, fallbackCapacity);
    block.occupiedSlots = occupiedSlots === undefined ? block.occupiedSlots : Math.max(toNumber(occupiedSlots, block.occupiedSlots), 0);
    block.occupiedSlots = Math.min(block.occupiedSlots, block.teuSlots);
    block.x = x === undefined ? block.x : Math.max(toNumber(x, block.x), 0);
    block.y = y === undefined ? block.y : Math.max(toNumber(y, block.y), 0);
    block.width = width === undefined ? block.width : Math.max(toNumber(width, block.width), 60);
    block.height = height === undefined ? block.height : Math.max(toNumber(height, block.height), 40);
    block.rotation = rotation === undefined ? block.rotation : toNumber(rotation, block.rotation);
    block.sortOrder = sortOrder === undefined ? block.sortOrder : toNumber(sortOrder, block.sortOrder);
    block.status = status ?? block.status;
    block.notes = notes ?? block.notes;
    await block.save();
    await block.populate("area", "name code");
    const payload = safeBlock(block);
    (0, socket_js_1.emitToAdmins)("inventory:block_updated", payload);
    (0, socket_js_1.emitToAdmins)("yard:block_updated", payload);
    return res.json({ success: true, message: "Inventory block updated successfully.", block: payload });
};
exports.updateYardBlock = updateYardBlock;
const deleteYardBlock = async (req, res) => {
    const block = await YardBlock_js_1.default.findById(req.params.id);
    if (!block) {
        return res.status(404).json({ success: false, message: "Inventory block not found." });
    }
    await YardBlock_js_1.default.deleteOne({ _id: block._id });
    const payload = { id: String(block._id), area: String(block.area) };
    (0, socket_js_1.emitToAdmins)("inventory:block_deleted", payload);
    (0, socket_js_1.emitToAdmins)("yard:block_deleted", payload);
    return res.json({ success: true, message: "Inventory block deleted successfully." });
};
exports.deleteYardBlock = deleteYardBlock;
