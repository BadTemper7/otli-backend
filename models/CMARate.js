"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const cmaRateSchema = new mongoose_1.default.Schema({
    cmaClient: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "CMAClient", default: null, index: true },
    description: { type: String, required: true, trim: true },
    chargeCode: { type: String, required: true, uppercase: true, trim: true },
    chargeType: { type: String, enum: ["lolo", "storage", "other"], required: true, index: true },
    rateType: { type: String, enum: ["local", "international"], default: "local", index: true },
    containerSize: { type: String, enum: ["all", "20", "40"], default: "all", index: true },
    containerType: {
        type: String,
        enum: ["all", "dry", "reefer", "tank", "open_top", "flat_rack"],
        default: "all",
        index: true,
    },
    loadStatus: { type: String, enum: ["all", "empty", "laden"], default: "all", index: true },
    unit: {
        type: String,
        enum: ["per_container", "per_teu", "per_day", "storage_day", "fixed"],
        default: "per_container",
        index: true,
    },
    rateAmount: { type: Number, required: true, min: 0 },
    freeDays: { type: Number, default: 0, min: 0 },
    minimumAmount: { type: Number, default: 0, min: 0 },
    effectiveDate: { type: Date, required: true, default: Date.now, index: true },
    effectiveTo: { type: Date, default: null, index: true },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    sortOrder: { type: Number, default: 100, index: true },
    notes: { type: String, default: "", trim: true },
    createdBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });
cmaRateSchema.index({ cmaClient: 1, rateType: 1, chargeCode: 1, containerSize: 1, containerType: 1, loadStatus: 1, effectiveDate: -1 });
cmaRateSchema.index({ status: 1, effectiveDate: 1, effectiveTo: 1 });
cmaRateSchema.pre("validate", function () {
    this.description = String(this.description || "").trim();
    this.chargeCode = String(this.chargeCode || this.description || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    this.rateType = this.rateType === "international" ? "international" : "local";
    this.containerSize = ["20", "40"].includes(String(this.containerSize)) ? String(this.containerSize) : "all";
    this.containerType = ["dry", "reefer", "tank", "open_top", "flat_rack"].includes(String(this.containerType)) ? String(this.containerType) : "all";
    this.loadStatus = ["empty", "laden"].includes(String(this.loadStatus).toLowerCase()) ? String(this.loadStatus).toLowerCase() : "all";
    if (this.chargeType === "storage" && !["per_day", "storage_day"].includes(this.unit)) this.unit = "storage_day";
    this.rateAmount = Math.max(Number(this.rateAmount) || 0, 0);
    this.freeDays = Math.max(Number(this.freeDays) || 0, 0);
    this.minimumAmount = Math.max(Number(this.minimumAmount) || 0, 0);
    this.sortOrder = Number.isFinite(Number(this.sortOrder)) ? Number(this.sortOrder) : 100;
    if (this.effectiveTo && this.effectiveDate && new Date(this.effectiveTo).getTime() <= new Date(this.effectiveDate).getTime()) {
        this.invalidate("effectiveTo", "Effective To must be later than Effective Date.");
    }
});
exports.default = mongoose_1.default.model("CMARate", cmaRateSchema);
