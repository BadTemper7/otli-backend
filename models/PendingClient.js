"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const pendingDocumentSchema = new mongoose_1.default.Schema({
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
const legalConsentSchema = new mongoose_1.default.Schema({
    termsAccepted: { type: Boolean, default: false },
    privacyAccepted: { type: Boolean, default: false },
    representativeAuthorityConfirmed: { type: Boolean, default: false },
    termsVersion: { type: String, default: "" },
    privacyPolicyVersion: { type: String, default: "" },
    acceptedAt: { type: Date, default: null },
    ipAddress: { type: String, default: "" },
    userAgent: { type: String, default: "" },
}, { _id: false });
const pendingClientSchema = new mongoose_1.default.Schema({
    clientId: { type: mongoose_1.default.Schema.Types.ObjectId, required: true, unique: true, sparse: true, index: true },
    companyName: { type: String, required: true, trim: true },
    companyAddress: { type: String, required: true, trim: true },
    companyType: { type: String, required: true, trim: true },
    companyTypeOther: { type: String, default: "" },
    companyMarket: { type: String, enum: ["local", "international"], required: true, default: "local", index: true },
    phoneNumber: { type: String, required: true, trim: true },
    representativeFirstName: { type: String, required: true, trim: true },
    representativeMiddleName: { type: String, default: "" },
    representativeLastName: { type: String, required: true, trim: true },
    representativePosition: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    password: { type: String, required: true },
    documents: { type: [pendingDocumentSchema], default: [] },
    legalConsent: { type: legalConsentSchema, default: () => ({}) },
    otpHash: { type: String, required: true, select: false },
    otpExpiresAt: { type: Date, required: true },
    otpAttempts: { type: Number, default: 0 },
    otpLastSentAt: { type: Date, default: null },
}, { timestamps: true });
exports.default = mongoose_1.default.model("PendingClient", pendingClientSchema);
