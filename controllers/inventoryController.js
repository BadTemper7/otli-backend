"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignInventoryContainer = exports.listInventoryContainers = void 0;
const InventoryContainer_js_1 = __importDefault(require("../models/InventoryContainer.js"));
const Booking_js_1 = __importDefault(require("../models/Booking.js"));
const YardArea_js_1 = __importDefault(require("../models/YardArea.js"));
const YardBlock_js_1 = __importDefault(require("../models/YardBlock.js"));
const socket_js_1 = require("../socket/socket.js");
const toNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};
const getYardCapacityUsage = (containerSize, yardContainerSize = 20) => {
    const size = Number(containerSize) || 20;
    const yardSize = Number(yardContainerSize) || 20;
    if (yardSize === 20) {
        if (size === 40) return 2;
        if (size === 45) return 2.25;
        return 1;
    }
    if (size === 20) return 0.5;
    if (size === 45) return 1.125;
    return 1;
};
const recalculateBlockOccupancy = async (blockId) => {
    if (!blockId)
        return;
    const [block, containers, bookingContainers] = await Promise.all([
        YardBlock_js_1.default.findById(blockId).select("containerSize"),
        InventoryContainer_js_1.default.find({ block: blockId, status: { $ne: "released" } }).select("containerSize"),
        Booking_js_1.default.find({
            assignedBlock: blockId,
            status: { $in: ["approved_area_assigned", "gate_in_approved", "stored_in_assigned_area", "gate_out_requested", "gate_out_approved"] },
        }).select("containerSize"),
    ]);
    if (!block)
        return;
    const occupiedSlots = [...containers, ...bookingContainers].reduce((total, container) => total + getYardCapacityUsage(container.containerSize, block.containerSize), 0);
    await YardBlock_js_1.default.findByIdAndUpdate(blockId, {
        occupiedSlots: Math.round(occupiedSlots * 100) / 100,
    });
};
const safeBookingContainer = (booking) => {
    const doc = booking.toObject ? booking.toObject() : booking;
    const client = doc.client || {};
    const area = doc.assignedArea || null;
    const block = doc.assignedBlock || null;
    return {
        id: String(doc._id),
        source: "booking",
        bookingReference: doc.bookingReference,
        preAdvice: "",
        gateIn: "",
        preAdviceNumber: "",
        gateInNumber: "",
        client: client?._id ? String(client._id) : String(doc.client),
        clientName: client.companyName || client.name || "",
        containerNumber: doc.containerNumber,
        containerSize: doc.containerSize,
        containerType: doc.containerType,
        containerStatus: doc.containerLoadStatus,
        shippingLine: doc.shippingLine,
        bookingNumber: doc.bookingNumber || "",
        blNumber: doc.blNumber || "",
        customerName: client.companyName || client.name || "",
        status: doc.status === "completed_gate_out_done" ? "released" : doc.status === "gate_in_approved" ? "gate_in_approved" : "in_yard",
        bookingStatus: doc.status,
        billingStatus: doc.billingStatus,
        area: area?._id ? String(area._id) : doc.assignedArea ? String(doc.assignedArea) : "",
        areaName: area?.name || "",
        block: block?._id ? String(block._id) : doc.assignedBlock ? String(doc.assignedBlock) : "",
        blockName: block?.name || "",
        blockCode: block?.code || "",
        bay: Number(doc.assignedBay) || 1,
        row: Number(doc.assignedRow) || 1,
        tier: Number(doc.assignedTier) || 1,
        slotNumber: doc.assignedSlotNumber || "",
        x: 40,
        y: 40,
        width: 92,
        height: 46,
        storageStartDate: doc.storageStartDate,
        inDate: doc.inDate || doc.expectedArrivalDate,
        outDate: doc.outDate,
        containerCondition: doc.physicalCondition || "",
        truckPlateNumber: doc.truckPlateNumber || "",
        driverName: doc.driverName || "",
        damageRemarks: doc.inspectionRemarks || "",
        assignedAt: doc.assignedAt,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
};
const safeContainer = (container) => {
    const doc = container.toObject ? container.toObject() : container;
    const client = doc.client || {};
    const area = doc.area || null;
    const block = doc.block || null;
    return {
        id: String(doc._id),
        preAdvice: doc.preAdvice?._id ? String(doc.preAdvice._id) : String(doc.preAdvice),
        gateIn: doc.gateIn?._id ? String(doc.gateIn._id) : String(doc.gateIn),
        preAdviceNumber: doc.preAdvice?.preAdviceNumber || "",
        gateInNumber: doc.gateIn?.gateInNumber || "",
        client: client?._id ? String(client._id) : String(doc.client),
        clientName: client.companyName || client.name || doc.customerName || "",
        containerNumber: doc.containerNumber,
        containerSize: doc.containerSize,
        containerType: doc.containerType,
        containerStatus: doc.containerStatus,
        shippingLine: doc.shippingLine,
        bookingNumber: doc.bookingNumber || "",
        blNumber: doc.blNumber || "",
        customerName: doc.customerName || "",
        status: doc.status,
        area: area?._id ? String(area._id) : doc.area ? String(doc.area) : "",
        areaName: area?.name || "",
        block: block?._id ? String(block._id) : doc.block ? String(doc.block) : "",
        blockName: block?.name || "",
        blockCode: block?.code || "",
        bay: Number(doc.bay) || 1,
        row: Number(doc.row) || 1,
        tier: Number(doc.tier) || 1,
        slotNumber: doc.slotNumber || "",
        x: Number(doc.x) || 40,
        y: Number(doc.y) || 40,
        width: Number(doc.width) || 92,
        height: Number(doc.height) || 46,
        storageStartDate: doc.storageStartDate,
        containerCondition: doc.containerCondition || "",
        truckPlateNumber: doc.truckPlateNumber || "",
        driverName: doc.driverName || "",
        damageRemarks: doc.damageRemarks || "",
        assignedAt: doc.assignedAt,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
};
const listInventoryContainers = async (req, res) => {
    const { areaId, status, search } = req.query;
    const query = {};
    const bookingQuery = { status: { $in: ["gate_in_approved", "stored_in_assigned_area", "gate_out_requested", "gate_out_approved", "completed_gate_out_done"] } };
    if (status && status !== "all")
        query.status = status;
    if (areaId) {
        query.$or = [{ area: areaId }, { area: null }];
        bookingQuery.$or = [{ assignedArea: areaId }, { assignedArea: null }];
    }
    if (search) {
        const term = String(search).trim();
        query.containerNumber = { $regex: term, $options: "i" };
        bookingQuery.$and = [
            ...(bookingQuery.$and || []),
            {
                $or: [
                    { containerNumber: { $regex: term, $options: "i" } },
                    { bookingReference: { $regex: term, $options: "i" } },
                ],
            },
        ];
    }
    const [containers, bookingContainers] = await Promise.all([
        InventoryContainer_js_1.default.find(query)
            .populate("client", "name email companyName")
            .populate("area", "name code")
            .populate("block", "name code")
            .populate("preAdvice", "preAdviceNumber status")
            .populate("gateIn", "gateInNumber status completedAt")
            .sort({ status: 1, createdAt: -1 })
            .limit(300),
        Booking_js_1.default.find(bookingQuery)
            .populate("client", "name email companyName")
            .populate("assignedArea", "name code")
            .populate("assignedBlock", "name code")
            .sort({ updatedAt: -1 })
            .limit(300),
    ]);
    const combined = [...bookingContainers.map(safeBookingContainer), ...containers.map((container) => ({ ...safeContainer(container), source: "pre_advice" }))];
    return res.json({ success: true, containers: combined });
};
exports.listInventoryContainers = listInventoryContainers;
const assignInventoryContainer = async (req, res) => {
    const { areaId, blockId, bay, row, tier, slotNumber, x, y, width, height } = req.body;
    const container = await InventoryContainer_js_1.default.findById(req.params.id);
    if (!container) {
        return res.status(404).json({ success: false, message: "Inventory container not found." });
    }
    if (!["awaiting_yard_assignment", "in_yard", "hold"].includes(container.status)) {
        return res.status(400).json({ success: false, message: `Container cannot be assigned from ${container.status} status.` });
    }
    if (!areaId || !blockId) {
        return res.status(400).json({ success: false, message: "Area and block are required before placing the container." });
    }
    const [area, block] = await Promise.all([YardArea_js_1.default.findById(areaId), YardBlock_js_1.default.findById(blockId)]);
    if (!area) {
        return res.status(404).json({ success: false, message: "Yard area not found." });
    }
    if (!block || String(block.area) !== String(area._id)) {
        return res.status(404).json({ success: false, message: "Selected block does not belong to this area." });
    }
    if (!["active", "full"].includes(block.status)) {
        return res.status(400).json({ success: false, message: "Container can only be placed in active blocks." });
    }
    const nextBay = Math.max(toNumber(bay, 1), 1);
    const nextRow = Math.max(toNumber(row, 1), 1);
    const nextTier = Math.max(toNumber(tier, 1), 1);
    if (nextBay > block.bayCount || nextRow > block.rowCount || nextTier > block.tierCount) {
        return res.status(400).json({
            success: false,
            message: `Location is outside block limits. Max bay ${block.bayCount}, row ${block.rowCount}, tier ${block.tierCount}.`,
        });
    }
    const autoSlotNumber = slotNumber || `${block.code}-B${nextBay}-R${nextRow}-T${nextTier}`;
    const occupiedSlot = await InventoryContainer_js_1.default.findOne({
        _id: { $ne: container._id },
        block: block._id,
        bay: nextBay,
        row: nextRow,
        tier: nextTier,
        status: { $ne: "released" },
    });
    if (occupiedSlot) {
        return res.status(409).json({ success: false, message: "That bay, row, and tier is already occupied." });
    }
    const [otherInventory, activeBookings] = await Promise.all([
        InventoryContainer_js_1.default.find({ _id: { $ne: container._id }, block: block._id, status: { $ne: "released" } }).select("containerSize"),
        Booking_js_1.default.find({
            assignedBlock: block._id,
            status: { $in: ["approved_area_assigned", "gate_in_approved", "stored_in_assigned_area", "gate_out_requested", "gate_out_approved"] },
        }).select("containerSize"),
    ]);
    const usedCapacity = [...otherInventory, ...activeBookings].reduce((total, item) => total + getYardCapacityUsage(item.containerSize, block.containerSize), 0);
    const incomingCapacity = getYardCapacityUsage(container.containerSize, block.containerSize);
    if (usedCapacity + incomingCapacity > Number(block.teuSlots)) {
        const unit = Number(block.containerSize) === 20 ? "TEU" : "FEU";
        return res.status(400).json({ success: false, message: `Selected yard area does not have enough available ${unit} capacity.` });
    }
    const previousBlockId = container.block ? String(container.block) : "";
    container.area = area._id;
    container.block = block._id;
    container.bay = nextBay;
    container.row = nextRow;
    container.tier = nextTier;
    container.slotNumber = autoSlotNumber;
    container.x = Math.max(toNumber(x, container.x || 40), 0);
    container.y = Math.max(toNumber(y, container.y || 40), 0);
    container.width = Math.max(toNumber(width, container.width || 92), 60);
    container.height = Math.max(toNumber(height, container.height || 46), 34);
    container.status = "in_yard";
    container.assignedAt = new Date();
    container.assignedBy = req.user._id;
    await container.save();
    await recalculateBlockOccupancy(block._id);
    if (previousBlockId && previousBlockId !== String(block._id)) {
        await recalculateBlockOccupancy(previousBlockId);
    }
    await container.populate("client", "name email companyName");
    await container.populate("area", "name code");
    await container.populate("block", "name code");
    await container.populate("preAdvice", "preAdviceNumber status");
    await container.populate("gateIn", "gateInNumber status completedAt");
    const payload = safeContainer(container);
    (0, socket_js_1.emitToAdmins)("inventory:container_assigned", payload);
    return res.json({ success: true, message: "Container assigned to yard location.", container: payload });
};
exports.assignInventoryContainer = assignInventoryContainer;
