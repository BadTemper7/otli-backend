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
const preAdviceSchema = new mongoose_1.default.Schema({
    client: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    preAdviceNumber: { type: String, required: true, unique: true, index: true },
    containerNumber: { type: String, required: true, uppercase: true, trim: true, index: true },
    containerSize: { type: Number, enum: [20, 40], required: true },
    containerType: {
        type: String,
        enum: ["dry", "reefer", "tank", "open_top", "flat_rack"],
        required: true,
    },
    containerStatus: { type: String, enum: ["empty", "laden"], required: true },
    shippingLine: { type: String, required: true, trim: true },
    bookingNumber: { type: String, default: "", trim: true },
    blNumber: { type: String, default: "", trim: true },
    vesselVoyage: { type: String, default: "", trim: true },
    cargoDescription: { type: String, default: "", trim: true },
    dangerousGoodsClassification: { type: String, default: "", trim: true },
    weight: { type: Number, default: 0 },
    arrivalDate: { type: Date, required: true },
    documents: { type: [documentSchema], default: [] },
    status: {
        type: String,
        enum: ["draft", "submitted", "pending_admin_confirmation", "rejected", "confirmed", "used_for_gate_in", "cancelled"],
        default: "pending_admin_confirmation",
        index: true,
    },
    rejectionReason: { type: String, default: "" },
    submittedAt: { type: Date, default: Date.now },
    confirmedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    gateAppointmentAt: { type: Date, default: null },
    qrCodeValue: { type: String, default: "" },
    plannedArea: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "YardArea", default: null, index: true },
    plannedBlock: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "YardBlock", default: null, index: true },
    plannedBay: { type: Number, default: 1 },
    plannedRow: { type: Number, default: 1 },
    plannedTier: { type: Number, default: 1 },
    plannedSlotNumber: { type: String, default: "" },
    plannedAt: { type: Date, default: null },
    plannedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });
preAdviceSchema.index({ containerNumber: 1, status: 1 });
preAdviceSchema.index({ plannedBlock: 1, plannedBay: 1, plannedRow: 1, plannedTier: 1, status: 1 });
exports.default = mongoose_1.default.model("PreAdvice", preAdviceSchema);
