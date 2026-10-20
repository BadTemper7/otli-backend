"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const cmaBillingLineItemSchema = new mongoose_1.default.Schema({
    rate: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "CMARate", default: null },
    chargeCode: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },
    chargeType: { type: String, enum: ["lolo", "storage", "other"], default: "other" },
    unit: { type: String, default: "per_container" },
    quantity: { type: Number, default: 1 },
    rateAmount: { type: Number, default: 0 },
    freeDays: { type: Number, default: 0 },
    minimumAmount: { type: Number, default: 0 },
    rateType: { type: String, enum: ["local", "international"], default: "local" },
    containerSize: { type: String, default: "all" },
    containerType: { type: String, default: "all" },
    loadStatus: { type: String, default: "all" },
    effectiveDate: { type: Date, default: null },
    serviceDate: { type: Date, default: null },
    billingPeriodStart: { type: Date, default: null },
    billingPeriodEnd: { type: Date, default: null },
    amount: { type: Number, default: 0 },
}, { _id: true });
const cmaPaymentSchema = new mongoose_1.default.Schema({
    amount: { type: Number, required: true, min: 0.01 },
    paymentDate: { type: Date, required: true, default: Date.now },
    referenceNumber: { type: String, required: true, trim: true },
    paymentType: { type: String, default: "", trim: true },
    remarks: { type: String, default: "", trim: true },
    recordedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    recordedAt: { type: Date, default: Date.now },
}, { _id: true });
const cmaBillingSchema = new mongoose_1.default.Schema({
    billingReference: { type: String, required: true, unique: true, index: true },
    booking: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "Booking", required: true, unique: true, index: true },
    cmaClient: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "CMAClient", required: true, index: true },
    truckerClient: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    bookingReference: { type: String, default: "", trim: true, index: true },
    bookingNumber: { type: String, default: "", trim: true, index: true },
    containerNumber: { type: String, default: "", uppercase: true, trim: true, index: true },
    containerSize: { type: Number, enum: [20, 40], default: 20 },
    containerType: { type: String, default: "", trim: true },
    containerLoadStatus: { type: String, enum: ["empty", "laden"], default: "empty" },
    rateType: { type: String, enum: ["local", "international"], default: "local" },
    shippingLine: { type: String, default: "", trim: true },
    gateInAt: { type: Date, default: null },
    gateOutAt: { type: Date, default: null },
    lineItems: { type: [cmaBillingLineItemSchema], default: [] },
    subtotal: { type: Number, default: 0 },
    isVatApplicable: { type: Boolean, default: true },
    vatRate: { type: Number, default: 0.12 },
    vatAmount: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    paidAmount: { type: Number, default: 0 },
    balanceDue: { type: Number, default: 0 },
    paymentStatus: { type: String, enum: ["unpaid", "partial", "paid"], default: "unpaid", index: true },
    payments: { type: [cmaPaymentSchema], default: [] },
    remarks: { type: String, default: "", trim: true },
    billingStage: { type: String, enum: ["gate_in", "gate_out"], default: "gate_in", index: true },
    computedAt: { type: Date, default: null },
    createdBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });
cmaBillingSchema.index({ cmaClient: 1, paymentStatus: 1, createdAt: -1 });
cmaBillingSchema.index({ truckerClient: 1, createdAt: -1 });
cmaBillingSchema.pre("validate", function () {
    this.subtotal = Math.max(Number(this.subtotal) || 0, 0);
    this.vatRate = Math.max(Number(this.vatRate) || 0, 0);
    this.vatAmount = Math.max(Number(this.vatAmount) || 0, 0);
    this.totalAmount = Math.max(Number(this.totalAmount) || 0, 0);
    this.paidAmount = Math.max((this.payments || []).reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0), 0);
    this.balanceDue = Math.max(Math.round((this.totalAmount - this.paidAmount) * 100) / 100, 0);
    this.paymentStatus = this.balanceDue <= 0 && this.totalAmount > 0 ? "paid" : this.paidAmount > 0 ? "partial" : "unpaid";
});
exports.default = mongoose_1.default.model("CMABilling", cmaBillingSchema);
