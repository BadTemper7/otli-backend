"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const yardBlockSchema = new mongoose_1.default.Schema({
    area: {
        type: mongoose_1.default.Schema.Types.ObjectId,
        ref: "YardArea",
        required: true,
        index: true,
    },
    name: {
        type: String,
        required: true,
        trim: true,
    },
    code: {
        type: String,
        required: true,
        uppercase: true,
        trim: true,
    },
    blockType: {
        type: String,
        enum: ["standard", "reefer", "empty", "laden", "inspection", "hold"],
        default: "standard",
    },
    bayCount: {
        type: Number,
        default: 1,
        min: 1,
    },
    rowCount: {
        type: Number,
        default: 1,
        min: 1,
    },
    tierCount: {
        type: Number,
        default: 1,
        min: 1,
    },
    containerSize: {
        type: Number,
        enum: [20, 40],
        default: 20,
    },
    teuSlots: {
        type: Number,
        default: 1,
        min: 1,
    },
    occupiedSlots: {
        type: Number,
        default: 0,
        min: 0,
    },
    x: {
        type: Number,
        default: 40,
        min: 0,
    },
    y: {
        type: Number,
        default: 40,
        min: 0,
    },
    width: {
        type: Number,
        default: 170,
        min: 60,
    },
    height: {
        type: Number,
        default: 90,
        min: 40,
    },
    rotation: {
        type: Number,
        default: 0,
    },
    sortOrder: {
        type: Number,
        default: 0,
    },
    status: {
        type: String,
        enum: ["active", "inactive", "maintenance", "full"],
        default: "active",
    },
    notes: {
        type: String,
        default: "",
        trim: true,
    },
}, { timestamps: true });
yardBlockSchema.index({ area: 1, code: 1 }, { unique: true });
yardBlockSchema.pre("validate", function () {
    if (this.code)
        this.code = this.code.toUpperCase().trim();
    this.bayCount = Math.max(Number(this.bayCount) || 1, 1);
    this.rowCount = Math.max(Number(this.rowCount) || 1, 1);
    this.tierCount = Math.max(Number(this.tierCount) || 1, 1);
    this.containerSize = [20, 40].includes(Number(this.containerSize)) ? Number(this.containerSize) : 20;
    const requestedCapacity = Math.max(Number(this.teuSlots) || 1, 1);
    const rowTierBoxes = Math.max(this.rowCount * this.tierCount, 1);
    const requiredBays = Math.ceil(requestedCapacity / rowTierBoxes);
    this.bayCount = Math.max(this.bayCount, requiredBays);
    const boxCount = this.bayCount * this.rowCount * this.tierCount;
    this.teuSlots = Math.min(requestedCapacity, boxCount);
    this.occupiedSlots = Math.min(Math.max(Number(this.occupiedSlots) || 0, 0), this.teuSlots);
    this.x = Math.max(Number(this.x) || 0, 0);
    this.y = Math.max(Number(this.y) || 0, 0);
    this.width = Math.max(Number(this.width) || 170, 60);
    this.height = Math.max(Number(this.height) || 90, 40);
    this.rotation = Number(this.rotation) || 0;
    this.sortOrder = Number(this.sortOrder) || 0;
});
exports.default = mongoose_1.default.model("YardBlock", yardBlockSchema);
