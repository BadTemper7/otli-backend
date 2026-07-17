"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const billingRateSchema = new mongoose_1.default.Schema({
    description: { type: String, required: true, trim: true },
    chargeCode: { type: String, required: true, uppercase: true, trim: true },
    rateType: { type: String, enum: ["local", "international"], default: "local", index: true },
    category: {
        type: String,
        enum: ["container_yard_operation", "stripping_stuffing", "custom"],
        default: "container_yard_operation",
        index: true,
    },
    billingScope: {
        type: String,
        enum: ["base", "storage", "optional_stripping_stuffing", "display_only"],
        default: "base",
        index: true,
    },
    unit: {
        type: String,
        enum: ["per_container", "per_teu", "per_day", "storage_day", "fixed"],
        default: "per_container",
        index: true,
    },
    unitLabel: { type: String, default: "", trim: true },
    containerSize: { type: String, enum: ["all", "20", "40"], default: "all", index: true },
    containerType: {
        type: String,
        enum: ["all", "dry", "reefer", "tank", "open_top", "flat_rack"],
        default: "all",
        index: true,
    },
    loadStatus: { type: String, enum: ["all", "empty", "laden"], default: "all", index: true },
    rateAmount: { type: Number, required: true, min: 0 },
    freeDays: { type: Number, default: 0, min: 0 },
    minimumAmount: { type: Number, default: 0, min: 0 },
    effectiveDate: { type: Date, required: true, default: Date.now, index: true },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    notes: { type: String, default: "", trim: true },
    sortOrder: { type: Number, default: 100, index: true },
}, { timestamps: true });
billingRateSchema.index({ rateType: 1, chargeCode: 1, effectiveDate: -1 });
billingRateSchema.index({ status: 1, rateType: 1, category: 1, billingScope: 1, containerSize: 1, containerType: 1, loadStatus: 1, effectiveDate: -1 });
billingRateSchema.pre("validate", function () {
    this.description = String(this.description || "").trim();
    this.chargeCode = String(this.chargeCode || this.description || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    this.rateType = this.rateType === "international" ? "international" : "local";
    this.category = ["container_yard_operation", "stripping_stuffing", "custom"].includes(this.category) ? this.category : "container_yard_operation";
    this.billingScope = ["base", "storage", "optional_stripping_stuffing", "display_only"].includes(this.billingScope) ? this.billingScope : "base";
    this.containerSize = String(this.containerSize || "all");
    this.containerType = String(this.containerType || "all");
    this.loadStatus = String(this.loadStatus || "all");
    const defaultUnitLabels = {
        per_container: "per container",
        per_teu: "per 20 ft equivalent",
        per_day: "per day",
        storage_day: "per container/day",
        fixed: "fixed charge",
    };
    this.unitLabel = String(this.unitLabel || defaultUnitLabels[this.unit] || this.unit || "").trim();
    this.rateAmount = Math.max(Number(this.rateAmount) || 0, 0);
    this.freeDays = Math.max(Number(this.freeDays) || 0, 0);
    this.minimumAmount = Math.max(Number(this.minimumAmount) || 0, 0);
    this.sortOrder = Number.isFinite(Number(this.sortOrder)) ? Number(this.sortOrder) : 100;
});
exports.default = mongoose_1.default.model("BillingRate", billingRateSchema);
