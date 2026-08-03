"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const documentSchema = new mongoose_1.default.Schema({
    type: { type: String, required: true },
    label: { type: String, required: true },
    fileName: { type: String, required: true },
    url: { type: String, required: true },
    secureUrl: { type: String, default: "" },
    publicId: { type: String, required: true },
    resourceType: { type: String, default: "auto" },
    mimeType: { type: String, default: "" },
    sizeBytes: { type: Number, default: 0 },
    uploadedAt: { type: Date, default: Date.now },
}, { _id: false });
const billingLineItemSchema = new mongoose_1.default.Schema({
    rate: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "BillingRate", default: null },
    chargeCode: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },
    unit: { type: String, default: "per_container", trim: true },
    quantity: { type: Number, default: 1 },
    rateAmount: { type: Number, default: 0 },
    freeDays: { type: Number, default: 0 },
    minimumAmount: { type: Number, default: 0 },
    category: { type: String, default: "", trim: true },
    billingScope: { type: String, default: "", trim: true },
    rateType: { type: String, enum: ["local", "international"], default: "local" },
    amount: { type: Number, default: 0 },
}, { _id: false });
const additionalChargeSchema = new mongoose_1.default.Schema({
    rate: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "BillingRate", default: null },
    chargeCode: { type: String, default: "", trim: true },
    source: { type: String, enum: ["manual", "congestion_surcharge"], default: "manual" },
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, default: 1, min: 0 },
    rateAmount: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: "", trim: true },
    addedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    addedAt: { type: Date, default: Date.now },
}, { _id: true });
const paymentTypeSnapshotSchema = new mongoose_1.default.Schema({
    type: { type: String, default: "" },
    name: { type: String, default: "" },
    bankName: { type: String, default: "" },
    accountNumber: { type: String, default: "" },
    accountName: { type: String, default: "" },
    qrUrl: { type: String, default: "" },
}, { _id: false });
const statusHistorySchema = new mongoose_1.default.Schema({
    status: { type: String, required: true },
    billingStatus: { type: String, default: "" },
    remarks: { type: String, default: "" },
    changedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    changedAt: { type: Date, default: Date.now },
}, { _id: false });
const paymentTransactionSchema = new mongoose_1.default.Schema({
    amount: { type: Number, default: 0, min: 0 },
    subtotal: { type: Number, default: 0, min: 0 },
    isVatApplicable: { type: Boolean, default: true },
    vatRate: { type: Number, default: 0, min: 0 },
    vatAmount: { type: Number, default: 0, min: 0 },
    grossTotal: { type: Number, default: 0, min: 0 },
    lineItems: { type: [billingLineItemSchema], default: [] },
    paymentTypeSnapshot: { type: paymentTypeSnapshotSchema, default: () => ({}) },
    referenceNumber: { type: String, default: "", trim: true },
    paymentDate: { type: Date, default: null },
    remarks: { type: String, default: "", trim: true },
    proofs: { type: [documentSchema], default: [] },
    submittedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    receiptNumber: { type: String, default: "", trim: true },
    receiptType: { type: String, enum: ["official_receipt", "acknowledgement_receipt"], default: "official_receipt" },
    cashReceived: { type: Number, default: 0, min: 0 },
    changeAmount: { type: Number, default: 0, min: 0 },
    source: { type: String, enum: ["online", "cash", "legacy"], default: "online" },
    archivedAt: { type: Date, default: Date.now },
}, { _id: true });
const bookingSchema = new mongoose_1.default.Schema({
    client: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    bookingReference: { type: String, required: true, unique: true, index: true },
    containerNumber: { type: String, required: true, uppercase: true, trim: true, index: true },
    containerSize: { type: Number, enum: [20, 40], required: true },
    containerType: {
        type: String,
        enum: ["dry", "reefer", "tank", "open_top", "flat_rack"],
        required: true,
    },
    containerLoadStatus: { type: String, enum: ["empty", "laden"], default: "empty" },
    rateType: { type: String, enum: ["local", "international"], default: "local", index: true },
    serviceType: {
        type: String,
        enum: ["container_yard", "stripping_stuffing_mano"],
        default: "container_yard",
        index: true,
    },
    shippingLine: { type: String, required: true, trim: true },
    bookingNumber: { type: String, default: "", trim: true },
    qrCodeValue: { type: String, default: "", trim: true },
    blNumber: { type: String, default: "", trim: true },
    vesselVoyage: { type: String, default: "", trim: true },
    cargoDescription: { type: String, default: "", trim: true },
    weight: { type: Number, default: 0 },
    expectedArrivalDate: { type: Date, required: true },
    inDate: { type: Date, default: null, index: true },
    outDate: { type: Date, default: null, index: true },
    clientRemarks: { type: String, default: "", trim: true },
    documents: { type: [documentSchema], default: [] },
    status: {
        type: String,
        enum: [
            "pending_admin_approval",
            "approved_area_assigned",
            "rejected",
            "gate_in_approved",
            "stored_in_assigned_area",
            "gate_out_requested",
            "gate_out_approved",
            "gate_out_reversal_requested",
            "completed_gate_out_done",
            "cancelled",
        ],
        default: "pending_admin_approval",
        index: true,
    },
    billingStatus: {
        type: String,
        enum: ["unpaid", "payment_submitted", "payment_under_review", "payment_rejected", "paid_approved"],
        default: "unpaid",
        index: true,
    },
    rejectionReason: { type: String, default: "" },
    submittedAt: { type: Date, default: Date.now },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    assignedArea: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "YardArea", default: null, index: true },
    assignedBlock: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "YardBlock", default: null, index: true },
    assignedBay: { type: Number, default: 1 },
    assignedRow: { type: Number, default: 1 },
    assignedTier: { type: Number, default: 1 },
    assignedSlotNumber: { type: String, default: "" },
    assignedAt: { type: Date, default: null },
    assignedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    gateInApprovedAt: { type: Date, default: null },
    gateInApprovedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    actualContainerNumber: { type: String, default: "", uppercase: true, trim: true },
    physicalCondition: { type: String, default: "Good", trim: true },
    sealNumber: { type: String, default: "", trim: true },
    truckPlateNumber: { type: String, default: "", trim: true },
    driverName: { type: String, default: "", trim: true },
    driverLicenseNumber: { type: String, default: "", trim: true },
    inspectionRemarks: { type: String, default: "", trim: true },
    storedAt: { type: Date, default: null },
    storedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    storageStartDate: { type: Date, default: null },
    billingLineItems: { type: [billingLineItemSchema], default: [] },
    additionalBillingCharges: { type: [additionalChargeSchema], default: [] },
    billingSubtotal: { type: Number, default: 0 },
    isVatApplicable: { type: Boolean, default: true, index: true },
    vatRate: { type: Number, default: 0.12 },
    vatAmount: { type: Number, default: 0 },
    billingTotal: { type: Number, default: 0 },
    billingDays: { type: Number, default: 0 },
    billingComputedAt: { type: Date, default: null },
    paymentAmount: { type: Number, default: 0 },
    approvedPaymentAmount: { type: Number, default: 0 },
    paymentCreditAmount: { type: Number, default: 0 },
    paymentBalanceDue: { type: Number, default: 0 },
    paymentApplicationStatus: {
        type: String,
        enum: ["none", "fully_applied", "partial_credit", "credit_available"],
        default: "none",
    },
    paymentTransactions: { type: [paymentTransactionSchema], default: [] },
    paymentType: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "PaymentType", default: null, index: true },
    paymentTypeSnapshot: { type: paymentTypeSnapshotSchema, default: () => ({}) },
    paymentReferenceNumber: { type: String, default: "", trim: true },
    paymentDate: { type: Date, default: null },
    paymentRemarks: { type: String, default: "", trim: true },
    paymentProofs: { type: [documentSchema], default: [] },
    paymentSubmittedAt: { type: Date, default: null },
    paymentReviewedAt: { type: Date, default: null },
    paymentReviewedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    paymentRejectionReason: { type: String, default: "" },
    cashReceived: { type: Number, default: 0 },
    changeAmount: { type: Number, default: 0 },
    receiptNumber: { type: String, default: "", trim: true, index: true },
    receiptType: { type: String, enum: ["official_receipt", "acknowledgement_receipt"], default: "official_receipt" },
    receiptGeneratedAt: { type: Date, default: null },
    gateOutRequestedAt: { type: Date, default: null },
    gateOutRequestRemarks: { type: String, default: "", trim: true },
    gateOutRejectedAt: { type: Date, default: null },
    gateOutRejectedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    gateOutRejectionReason: { type: String, default: "", trim: true },
    gateOutApprovedAt: { type: Date, default: null },
    gateOutApprovedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    gateOutRemarks: { type: String, default: "", trim: true },
    gateOutReversalRequestedAt: { type: Date, default: null },
    gateOutReversalRequestedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    gateOutReversalRequestReason: { type: String, default: "", trim: true },
    gateOutReversalReviewedAt: { type: Date, default: null },
    gateOutReversalReviewedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    gateOutReversalDecision: { type: String, enum: ["", "approved", "rejected"], default: "" },
    gateOutReversalAdminRemarks: { type: String, default: "", trim: true },
    gateOutReversalCount: { type: Number, default: 0 },
    releasedAt: { type: Date, default: null },
    releasedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    releaseRemarks: { type: String, default: "", trim: true },
    releaseReport: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "ReleaseReport", default: null, index: true },
    reportGeneratedAt: { type: Date, default: null, index: true },
    revenueRecordedAt: { type: Date, default: null, index: true },
    statusHistory: { type: [statusHistorySchema], default: [] },
}, { timestamps: true });
bookingSchema.index({ assignedBlock: 1, assignedBay: 1, assignedRow: 1, assignedTier: 1, status: 1 });
bookingSchema.index({ containerNumber: 1, status: 1 });
bookingSchema.pre("validate", function () {
    if (this.containerNumber) {
        this.containerNumber = String(this.containerNumber).toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
    }
    if (this.actualContainerNumber) {
        this.actualContainerNumber = String(this.actualContainerNumber).toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
    }
    this.rateType = this.rateType === "international" ? "international" : "local";
    this.assignedBay = Math.max(Number(this.assignedBay) || 1, 1);
    this.assignedRow = Math.max(Number(this.assignedRow) || 1, 1);
    this.assignedTier = Math.max(Number(this.assignedTier) || 1, 1);
    this.billingSubtotal = Math.max(Number(this.billingSubtotal) || 0, 0);
    this.vatRate = Math.max(Number(this.vatRate) || 0, 0);
    this.vatAmount = Math.max(Number(this.vatAmount) || 0, 0);
    this.billingTotal = Math.max(Number(this.billingTotal) || 0, 0);
    this.billingDays = Math.max(Number(this.billingDays) || 0, 0);
    this.paymentAmount = Math.max(Number(this.paymentAmount) || 0, 0);
    this.approvedPaymentAmount = Math.max(Number(this.approvedPaymentAmount) || 0, 0);
    this.paymentCreditAmount = Math.max(Number(this.paymentCreditAmount) || 0, 0);
    this.paymentBalanceDue = Math.max(Number(this.paymentBalanceDue) || 0, 0);
    this.gateOutReversalCount = Math.max(Number(this.gateOutReversalCount) || 0, 0);
    this.cashReceived = Math.max(Number(this.cashReceived) || 0, 0);
    this.changeAmount = Math.max(Number(this.changeAmount) || 0, 0);
    this.additionalBillingCharges = (this.additionalBillingCharges || []).map((item) => {
        item.quantity = Math.max(Number(item.quantity) || 0, 0);
        item.rateAmount = Math.max(Number(item.rateAmount) || 0, 0);
        item.amount = Math.round(item.quantity * item.rateAmount * 100) / 100;
        return item;
    });
    this.weight = Math.max(Number(this.weight) || 0, 0);
});
exports.default = mongoose_1.default.model("Booking", bookingSchema);
