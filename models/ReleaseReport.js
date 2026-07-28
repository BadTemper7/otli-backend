"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const releaseReportSchema = new mongoose_1.default.Schema({
    reportNumber: { type: String, required: true, unique: true, index: true, trim: true },
    booking: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "Booking", required: true, unique: true, index: true },
    client: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    bookingReference: { type: String, required: true, trim: true, index: true },
    bookingNumber: { type: String, default: "", trim: true },
    containerNumber: { type: String, required: true, uppercase: true, trim: true, index: true },
    containerSize: { type: Number, enum: [20, 40], required: true },
    containerType: { type: String, default: "", trim: true },
    containerLoadStatus: { type: String, default: "", trim: true },
    rateType: { type: String, enum: ["local", "international"], required: true, index: true },
    serviceType: { type: String, default: "container_yard", trim: true },
    shippingLine: { type: String, default: "", trim: true },
    gateInAt: { type: Date, default: null },
    storageStartDate: { type: Date, default: null },
    releasedAt: { type: Date, required: true, index: true },
    billingDays: { type: Number, default: 0, min: 0 },
    billingSubtotal: { type: Number, default: 0, min: 0 },
    vatRate: { type: Number, default: 0, min: 0 },
    vatAmount: { type: Number, default: 0, min: 0 },
    revenueTotal: { type: Number, default: 0, min: 0 },
    paymentReferenceNumber: { type: String, default: "", trim: true },
    paymentDate: { type: Date, default: null },
    paymentStatus: { type: String, default: "paid_approved", trim: true },
    generatedAt: { type: Date, default: Date.now, index: true },
    generatedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });
releaseReportSchema.index({ client: 1, releasedAt: -1 });
releaseReportSchema.pre("validate", function () {
    if (this.containerNumber)
        this.containerNumber = String(this.containerNumber).toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
    this.rateType = this.rateType === "international" ? "international" : "local";
    this.billingDays = Math.max(Number(this.billingDays) || 0, 0);
    this.billingSubtotal = Math.max(Number(this.billingSubtotal) || 0, 0);
    this.vatRate = Math.max(Number(this.vatRate) || 0, 0);
    this.vatAmount = Math.max(Number(this.vatAmount) || 0, 0);
    this.revenueTotal = Math.max(Number(this.revenueTotal) || 0, 0);
});
exports.default = mongoose_1.default.model("ReleaseReport", releaseReportSchema);
