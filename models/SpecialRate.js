"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const specialRateItemSchema = new mongoose_1.default.Schema({
    transactionKey: { type: String, required: true, trim: true },
    billingRate: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "BillingRate", default: null },
    chargeCode: { type: String, required: true, uppercase: true, trim: true },
    description: { type: String, required: true, trim: true },
    rateType: { type: String, enum: ["local", "international"], required: true },
    containerSize: { type: String, enum: ["all", "20", "40"], default: "all" },
    containerType: { type: String, default: "all" },
    loadStatus: { type: String, enum: ["all", "empty", "laden"], default: "all" },
    unit: { type: String, default: "per_container" },
    unitLabel: { type: String, default: "" },
    specialRateAmount: { type: Number, required: true, min: 0 },
}, { _id: true });
const specialRateSchema = new mongoose_1.default.Schema({
    name: { type: String, required: true, trim: true },
    clients: [{ type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", required: true }],
    transactions: { type: [specialRateItemSchema], default: [] },
    effectiveDate: { type: Date, required: true, index: true },
    effectiveTo: { type: Date, default: null, index: true },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    notes: { type: String, default: "", trim: true },
    createdBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });
specialRateSchema.index({ clients: 1, status: 1, effectiveDate: -1, effectiveTo: 1 });
specialRateSchema.index({ "transactions.transactionKey": 1, status: 1, effectiveDate: -1, effectiveTo: 1 });
specialRateSchema.pre("validate", function () {
    this.name = String(this.name || "").trim();
    this.clients = [...new Set((this.clients || []).map((id) => String(id)))];
    if (!this.clients.length)
        this.invalidate("clients", "Select at least one client.");
    if (!this.transactions?.length)
        this.invalidate("transactions", "Add at least one transaction rate.");
    const seen = new Set();
    for (const item of this.transactions || []) {
        item.transactionKey = String(item.transactionKey || "").trim();
        if (seen.has(item.transactionKey))
            this.invalidate("transactions", `Duplicate transaction ${item.description || item.chargeCode}.`);
        seen.add(item.transactionKey);
        item.specialRateAmount = Math.max(Number(item.specialRateAmount) || 0, 0);
    }
    if (this.effectiveTo && this.effectiveDate && new Date(this.effectiveTo).getTime() <= new Date(this.effectiveDate).getTime()) {
        this.invalidate("effectiveTo", "Effective To must be later than Effectivity Date.");
    }
});
exports.default = mongoose_1.default.model("SpecialRate", specialRateSchema);
