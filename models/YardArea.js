"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const yardAreaSchema = new mongoose_1.default.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    code: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true,
    },
    lineCount: {
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
    capacityTeu: {
        type: Number,
        default: 1,
        min: 1,
    },
    description: {
        type: String,
        default: "",
        trim: true,
    },
    isCongestionArea: {
        type: Boolean,
        default: false,
        index: true,
    },
    status: {
        type: String,
        enum: ["active", "inactive", "maintenance"],
        default: "active",
    },
    color: {
        type: String,
        default: "#0f766e",
        trim: true,
    },
    sortOrder: {
        type: Number,
        default: 0,
    },
}, { timestamps: true });
yardAreaSchema.pre("validate", function () {
    if (this.code)
        this.code = this.code.toUpperCase().trim();
    this.lineCount = Math.max(Number(this.lineCount) || 1, 1);
    this.rowCount = Math.max(Number(this.rowCount) || 1, 1);
    this.tierCount = Math.max(Number(this.tierCount) || 1, 1);
    this.containerSize = [20, 40].includes(Number(this.containerSize)) ? Number(this.containerSize) : 20;
    const requestedCapacity = Math.max(Number(this.capacityTeu) || 1, 1);
    const rowTierBoxes = Math.max(this.rowCount * this.tierCount, 1);
    const requiredBays = Math.ceil(requestedCapacity / rowTierBoxes);
    this.lineCount = Math.max(this.lineCount, requiredBays);
    const boxCount = this.lineCount * this.rowCount * this.tierCount;
    this.capacityTeu = Math.min(requestedCapacity, boxCount);
    this.sortOrder = Number(this.sortOrder) || 0;
});
exports.default = mongoose_1.default.model("YardArea", yardAreaSchema);
