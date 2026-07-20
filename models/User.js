"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const permissions_js_1 = require("../utils/permissions.js");
const permissionsSchema = new mongoose_1.default.Schema({
    view: { type: Boolean, default: false },
    create: { type: Boolean, default: false },
    edit: { type: Boolean, default: false },
    delete: { type: Boolean, default: false },
}, { _id: false });
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
const userSchema = new mongoose_1.default.Schema({
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6, select: false },
    userType: { type: String, enum: ["admin", "client"], required: true },
    role: { type: String, enum: ["super_admin", "admin", "staff", "client"], required: true },
    companyName: { type: String, default: "" },
    companyAddress: { type: String, default: "" },
    companyType: { type: String, default: "" },
    companyTypeOther: { type: String, default: "" },
    companyMarket: { type: String, enum: ["local", "international"], default: "local", index: true },
    phoneNumber: { type: String, default: "" },
    representativeFirstName: { type: String, default: "" },
    representativeMiddleName: { type: String, default: "" },
    representativeLastName: { type: String, default: "" },
    representativePosition: { type: String, default: "" },
    documents: { type: [documentSchema], default: [] },
    legalConsent: { type: legalConsentSchema, default: () => ({}) },
    rejectionReason: { type: String, default: "" },
    rejectedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    resubmittedAt: { type: Date, default: null },
    status: {
        type: String,
        enum: ["active", "pending", "verified", "resubmitted", "suspended", "rejected"],
        default: "active",
    },
    isEmailVerified: { type: Boolean, default: false },
    isLockedSeed: { type: Boolean, default: false },
    permissions: {
        dashboard: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        accounts: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        clients: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        yardSetup: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        inventory: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        yardMap: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        userManagement: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        roleAccess: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        clientVerification: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        preAdvice: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        bookings: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        gateAppointment: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        gateIn: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        storageMonitoring: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        rateSetup: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        paymentTypes: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        billing: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        paymentVerification: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        gateOut: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        blacklist: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        chargeHold: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        reports: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        auditTrail: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
        settings: { type: permissionsSchema, default: () => ({ view: false, create: false, edit: false, delete: false }) },
    },
    passwordResetOtpHash: { type: String, select: false, default: "" },
    passwordResetExpiresAt: { type: Date, default: null },
    passwordResetAttempts: { type: Number, default: 0 },
    passwordResetLastSentAt: { type: Date, default: null },
}, { timestamps: true });
userSchema.pre("validate", function () {
    if (!this.permissions || Object.keys(this.permissions).length === 0) {
        this.permissions = (0, permissions_js_1.getEmptyPermissions)();
    }
});
userSchema.pre("save", async function () {
    if (!this.isModified("password"))
        return;
    const looksHashed = /^\$2[aby]\$/.test(this.password);
    if (looksHashed)
        return;
    const salt = await bcryptjs_1.default.genSalt(10);
    this.password = await bcryptjs_1.default.hash(this.password, salt);
});
userSchema.methods.matchPassword = async function (enteredPassword) {
    return bcryptjs_1.default.compare(enteredPassword, this.password);
};
exports.default = mongoose_1.default.model("User", userSchema);
