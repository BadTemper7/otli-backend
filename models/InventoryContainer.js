"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const inventoryContainerSchema = new mongoose_1.default.Schema({
    preAdvice: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "PreAdvice", required: true, unique: true, index: true },
    gateIn: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "GateInRecord", required: true, unique: true, index: true },
    client: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    containerNumber: { type: String, required: true, uppercase: true, trim: true, index: true },
    containerSize: { type: Number, enum: [20, 40], required: true },
    containerType: { type: String, required: true },
    containerStatus: { type: String, required: true },
    shippingLine: { type: String, required: true },
    bookingNumber: { type: String, default: "" },
    blNumber: { type: String, default: "" },
    customerName: { type: String, default: "" },
    status: {
        type: String,
        enum: ["awaiting_yard_assignment", "in_yard", "for_billing", "pending_payment", "payment_verified", "cleared_for_gate_out", "released", "hold"],
        default: "awaiting_yard_assignment",
        index: true,
    },
    area: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "YardArea", default: null, index: true },
    block: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "YardBlock", default: null, index: true },
    bay: { type: Number, default: 1 },
    row: { type: Number, default: 1 },
    tier: { type: Number, default: 1 },
    slotNumber: { type: String, default: "" },
    x: { type: Number, default: 40 },
    y: { type: Number, default: 40 },
    width: { type: Number, default: 92 },
    height: { type: Number, default: 46 },
    storageStartDate: { type: Date, default: Date.now },
    containerCondition: { type: String, default: "Good" },
    truckPlateNumber: { type: String, default: "" },
    driverName: { type: String, default: "" },
    damageRemarks: { type: String, default: "" },
    assignedAt: { type: Date, default: null },
    assignedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });
inventoryContainerSchema.index({ area: 1, block: 1, bay: 1, row: 1, tier: 1 });
exports.default = mongoose_1.default.model("InventoryContainer", inventoryContainerSchema);
