"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const paymentTypeSchema = new mongoose_1.default.Schema({
    type: { type: String, enum: ["bank", "ewallet"], required: true, index: true },
    name: { type: String, required: true, trim: true },
    bankName: { type: String, default: "", trim: true },
    accountNumber: { type: String, required: true, trim: true },
    accountName: { type: String, required: true, trim: true },
    qrUrl: { type: String, default: "", trim: true },
    qrSecureUrl: { type: String, default: "", trim: true },
    qrPublicId: { type: String, default: "", trim: true },
    instructions: { type: String, default: "", trim: true },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    sortOrder: { type: Number, default: 100, index: true },
}, { timestamps: true });
paymentTypeSchema.pre("validate", function () {
    this.type = this.type === "ewallet" ? "ewallet" : "bank";
    this.name = String(this.name || "").trim();
    this.bankName = String(this.bankName || "").trim();
    this.accountNumber = String(this.accountNumber || "").trim();
    this.accountName = String(this.accountName || "").trim();
    this.instructions = String(this.instructions || "").trim();
    this.sortOrder = Number.isFinite(Number(this.sortOrder)) ? Number(this.sortOrder) : 100;
});
paymentTypeSchema.index({ status: 1, type: 1, sortOrder: 1, name: 1 });
exports.default = mongoose_1.default.model("PaymentType", paymentTypeSchema);
