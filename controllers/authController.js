"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTestEmail = exports.changePassword = exports.resetPassword = exports.forgotPassword = exports.verifyClientRegistrationOtp = exports.resendClientRegistrationOtp = exports.requestClientRegistrationOtp = exports.me = exports.login = exports.safeUser = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const mongoose_1 = __importDefault(require("mongoose"));
const User_js_1 = __importDefault(require("../models/User.js"));
const PendingClient_js_1 = __importDefault(require("../models/PendingClient.js"));
const localFileStorage_js_1 = require("../utils/localFileStorage.js");
const mailer_js_1 = require("../config/mailer.js");
const generateOtp_js_1 = require("../utils/generateOtp.js");
const jwt_js_1 = require("../utils/jwt.js");
const emailTemplates_js_1 = require("../utils/emailTemplates.js");
const socket_js_1 = require("../socket/socket.js");
const permissions_js_1 = require("../utils/permissions.js");
const legalPolicies_js_1 = require("../utils/legalPolicies.js");
const documentLabels = {
    businessPermit: "Business Permit",
    birCertificate: "BIR Certificate",
    validId: "Valid ID",
    authorizationLetter: "Authorization Letter",
    otherDocument: "Other Document",
};
const requiredDocumentFields = ["businessPermit", "birCertificate", "validId"];
const isAffirmativeConsent = (value) => ["true", "1", "yes", "on"].includes(String(value || "").trim().toLowerCase());
const getRequestIpAddress = (req) => {
    const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
    return forwarded || req.socket?.remoteAddress || req.ip || "";
};
const hasCompleteLegalConsent = (legalConsent) => Boolean(legalConsent?.termsAccepted &&
    legalConsent?.privacyAccepted &&
    legalConsent?.representativeAuthorityConfirmed &&
    legalConsent?.acceptedAt);
const getOtpExpiryDate = () => {
    const minutes = Number(process.env.EMAIL_OTP_EXPIRES_MINUTES || 10);
    return new Date(Date.now() + minutes * 60 * 1000);
};
const canResendOtp = (lastSentAt) => {
    if (!lastSentAt)
        return true;
    const resendSeconds = Number(process.env.EMAIL_OTP_RESEND_SECONDS || 60);
    const diffMs = Date.now() - new Date(lastSentAt).getTime();
    return diffMs >= resendSeconds * 1000;
};
const getRepresentativeName = (user) => {
    const parts = [user.representativeFirstName, user.representativeMiddleName, user.representativeLastName]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    return parts || user.name;
};
const safeUser = (user) => {
    const role = user.role;
    const permissions = ["super_admin", "admin"].includes(role)
        ? (0, permissions_js_1.getAllAccessPermissions)()
        : (0, permissions_js_1.normalizePermissions)(user.permissions);
    return {
        id: user._id,
        name: user.name,
        email: user.email,
        userType: user.userType,
        role,
        companyName: user.companyName,
        companyAddress: user.companyAddress,
        companyType: user.companyType,
        companyTypeOther: user.companyTypeOther,
        phoneNumber: user.phoneNumber,
        representativeFirstName: user.representativeFirstName,
        representativeMiddleName: user.representativeMiddleName,
        representativeLastName: user.representativeLastName,
        representativePosition: user.representativePosition,
        documents: user.documents,
        rejectionReason: user.rejectionReason || "",
        rejectedAt: user.rejectedAt,
        verifiedAt: user.verifiedAt,
        resubmittedAt: user.resubmittedAt,
        status: user.status,
        isEmailVerified: user.isEmailVerified,
        legalConsent: user.legalConsent ? {
            termsAccepted: Boolean(user.legalConsent.termsAccepted),
            privacyAccepted: Boolean(user.legalConsent.privacyAccepted),
            representativeAuthorityConfirmed: Boolean(user.legalConsent.representativeAuthorityConfirmed),
            termsVersion: user.legalConsent.termsVersion || "",
            privacyPolicyVersion: user.legalConsent.privacyPolicyVersion || "",
            acceptedAt: user.legalConsent.acceptedAt || null,
        } : null,
        permissions,
        isLockedSeed: user.isLockedSeed,
    };
};
exports.safeUser = safeUser;
const uploadRegistrationDocuments = async ({ files, clientId }) => {
    const uploadedDocs = [];
    for (const fieldName of Object.keys(documentLabels)) {
        const file = files?.[fieldName]?.[0];
        if (!file)
            continue;
        const result = await (0, localFileStorage_js_1.saveUploadedFile)({
            file,
            clientId,
            category: "registration",
            prefix: fieldName,
        });
        uploadedDocs.push({
            type: fieldName,
            label: documentLabels[fieldName],
            fileName: file.originalname,
            url: result.url,
            secureUrl: result.secureUrl,
            publicId: result.publicId,
            resourceType: result.resourceType || "local",
            mimeType: file.mimetype,
            sizeBytes: file.size,
            uploadedAt: new Date(),
        });
    }
    return uploadedDocs;
};
const login = async (req, res) => {
    const { email, password, loginType } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, message: "Email and password are required." });
    }
    const user = await User_js_1.default.findOne({ email: email.toLowerCase() }).select("+password");
    if (!user) {
        return res.status(401).json({ success: false, message: "Invalid email or password." });
    }
    if (loginType === "admin" && user.userType !== "admin") {
        return res.status(403).json({ success: false, message: "This login page is for admin accounts only." });
    }
    if (loginType === "client" && user.userType !== "client") {
        return res.status(403).json({ success: false, message: "This login page is for client accounts only." });
    }
    const clientLoginAllowedStatuses = ["active", "verified", "pending", "resubmitted", "rejected"];
    const canLogin = user.userType === "admin" ? user.status === "active" : clientLoginAllowedStatuses.includes(user.status);
    if (!canLogin) {
        return res.status(403).json({ success: false, message: `Your account is ${user.status}.` });
    }
    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
        return res.status(401).json({ success: false, message: "Invalid email or password." });
    }
    const token = (0, jwt_js_1.generateToken)(user._id);
    return res.json({
        success: true,
        message: "Login successful.",
        token,
        user: (0, exports.safeUser)(user),
    });
};
exports.login = login;
const me = async (req, res) => {
    return res.json({ success: true, user: (0, exports.safeUser)(req.user) });
};
exports.me = me;
const requestClientRegistrationOtp = async (req, res) => {
    const { companyName, companyAddress, companyType, companyTypeOther, phoneNumber, representativeFirstName, representativeMiddleName, representativeLastName, representativePosition, email, password, confirmPassword, termsAccepted, privacyAccepted, representativeAuthorityConfirmed, } = req.body;
    const requiredFields = [
        companyName,
        companyAddress,
        companyType,
        phoneNumber,
        representativeFirstName,
        representativeLastName,
        representativePosition,
        email,
        password,
        confirmPassword,
    ];
    if (requiredFields.some((value) => !String(value || "").trim())) {
        return res.status(400).json({ success: false, message: "Please complete all required fields." });
    }
    if (password !== confirmPassword) {
        return res.status(400).json({ success: false, message: "Password and confirm password do not match." });
    }
    if (!isAffirmativeConsent(termsAccepted) || !isAffirmativeConsent(privacyAccepted) || !isAffirmativeConsent(representativeAuthorityConfirmed)) {
        return res.status(400).json({
            success: false,
            message: "You must accept the Terms and Conditions, consent to the Privacy Policy, and confirm your authority to register the company.",
        });
    }
    const missingDocuments = requiredDocumentFields.filter((fieldName) => !req.files?.[fieldName]?.[0]);
    if (missingDocuments.length) {
        return res.status(400).json({
            success: false,
            message: `Missing required documents: ${missingDocuments.map((field) => documentLabels[field]).join(", ")}.`,
        });
    }
    const normalizedEmail = email.toLowerCase().trim();
    const existingUser = await User_js_1.default.findOne({ email: normalizedEmail });
    if (existingUser) {
        return res.status(409).json({ success: false, message: "Email is already registered." });
    }
    const existingPending = await PendingClient_js_1.default.findOne({ email: normalizedEmail }).select("+otpHash");
    if (existingPending && !canResendOtp(existingPending.otpLastSentAt)) {
        return res.status(429).json({
            success: false,
            message: `Please wait ${process.env.EMAIL_OTP_RESEND_SECONDS || 60} seconds before requesting another OTP.`,
        });
    }
    const reservedClientId = existingPending?.clientId || new mongoose_1.default.Types.ObjectId();
    const uploadedDocs = await uploadRegistrationDocuments({
        files: req.files,
        clientId: reservedClientId,
    });
    const otp = (0, generateOtp_js_1.generateOtp)();
    const otpHash = await (0, generateOtp_js_1.hashOtp)(otp);
    const passwordHash = await bcryptjs_1.default.hash(password, 10);
    await PendingClient_js_1.default.findOneAndUpdate({ email: normalizedEmail }, {
        clientId: reservedClientId,
        companyName,
        companyAddress,
        companyType,
        companyTypeOther: companyTypeOther || "",
        phoneNumber,
        representativeFirstName,
        representativeMiddleName: representativeMiddleName || "",
        representativeLastName,
        representativePosition,
        email: normalizedEmail,
        password: passwordHash,
        documents: uploadedDocs,
        legalConsent: {
            termsAccepted: true,
            privacyAccepted: true,
            representativeAuthorityConfirmed: true,
            termsVersion: legalPolicies_js_1.TERMS_VERSION,
            privacyPolicyVersion: legalPolicies_js_1.PRIVACY_POLICY_VERSION,
            acceptedAt: new Date(),
            ipAddress: getRequestIpAddress(req),
            userAgent: String(req.headers?.["user-agent"] || "").slice(0, 500),
        },
        otpHash,
        otpExpiresAt: getOtpExpiryDate(),
        otpAttempts: 0,
        otpLastSentAt: new Date(),
    }, { upsert: true, new: true, setDefaultsOnInsert: true });
    await (0, mailer_js_1.sendEmail)({
        to: normalizedEmail,
        subject: "OTLI Client Registration OTP",
        html: (0, emailTemplates_js_1.otpEmailTemplate)({
            title: "OTLI Client Registration",
            otp,
            message: "Use this OTP to verify your email and submit your client registration.",
        }),
    });
    return res.json({ success: true, message: "OTP has been sent to your email." });
};
exports.requestClientRegistrationOtp = requestClientRegistrationOtp;
const resendClientRegistrationOtp = async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, message: "Email is required." });
    }
    const normalizedEmail = email.toLowerCase().trim();
    const pending = await PendingClient_js_1.default.findOne({ email: normalizedEmail }).select("+otpHash");
    if (!pending) {
        return res.status(404).json({ success: false, message: "No pending registration found." });
    }
    if (!hasCompleteLegalConsent(pending.legalConsent)) {
        return res.status(400).json({
            success: false,
            message: "Please restart registration and accept the current Terms and Conditions and Privacy Policy.",
        });
    }
    if (!canResendOtp(pending.otpLastSentAt)) {
        return res.status(429).json({
            success: false,
            message: `Please wait ${process.env.EMAIL_OTP_RESEND_SECONDS || 60} seconds before requesting another OTP.`,
        });
    }
    const otp = (0, generateOtp_js_1.generateOtp)();
    pending.otpHash = await (0, generateOtp_js_1.hashOtp)(otp);
    pending.otpExpiresAt = getOtpExpiryDate();
    pending.otpAttempts = 0;
    pending.otpLastSentAt = new Date();
    await pending.save();
    await (0, mailer_js_1.sendEmail)({
        to: normalizedEmail,
        subject: "OTLI Client Registration OTP",
        html: (0, emailTemplates_js_1.otpEmailTemplate)({
            title: "OTLI Client Registration",
            otp,
            message: "Use this new OTP to verify your email and submit your client registration.",
        }),
    });
    return res.json({ success: true, message: "A new OTP has been sent to your email." });
};
exports.resendClientRegistrationOtp = resendClientRegistrationOtp;
const verifyClientRegistrationOtp = async (req, res) => {
    const { email, otp } = req.body;
    if (!email || !otp) {
        return res.status(400).json({ success: false, message: "Email and OTP are required." });
    }
    const normalizedEmail = email.toLowerCase().trim();
    const pending = await PendingClient_js_1.default.findOne({ email: normalizedEmail }).select("+otpHash");
    if (!pending) {
        return res.status(404).json({ success: false, message: "No pending registration found." });
    }
    if (!hasCompleteLegalConsent(pending.legalConsent)) {
        return res.status(400).json({
            success: false,
            message: "Please restart registration and accept the current Terms and Conditions and Privacy Policy.",
        });
    }
    if (pending.otpExpiresAt < new Date()) {
        return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
    }
    const maxAttempts = Number(process.env.EMAIL_OTP_MAX_ATTEMPTS || 5);
    if (pending.otpAttempts >= maxAttempts) {
        return res.status(429).json({ success: false, message: "Too many incorrect attempts. Please request a new OTP." });
    }
    const isValidOtp = await (0, generateOtp_js_1.compareOtp)(otp, pending.otpHash);
    if (!isValidOtp) {
        pending.otpAttempts += 1;
        await pending.save();
        return res.status(400).json({ success: false, message: "Invalid OTP." });
    }
    const defaultClientStatus = process.env.CLIENT_REGISTER_DEFAULT_STATUS || "pending";
    const user = await User_js_1.default.create({
        _id: pending.clientId || pending._id,
        name: `${pending.representativeFirstName} ${pending.representativeLastName}`.trim(),
        email: pending.email,
        password: pending.password,
        userType: "client",
        role: "client",
        companyName: pending.companyName,
        companyAddress: pending.companyAddress,
        companyType: pending.companyType,
        companyTypeOther: pending.companyTypeOther,
        phoneNumber: pending.phoneNumber,
        representativeFirstName: pending.representativeFirstName,
        representativeMiddleName: pending.representativeMiddleName,
        representativeLastName: pending.representativeLastName,
        representativePosition: pending.representativePosition,
        documents: pending.documents,
        legalConsent: pending.legalConsent,
        status: defaultClientStatus,
        isEmailVerified: true,
    });
    await PendingClient_js_1.default.deleteOne({ _id: pending._id });
    (0, socket_js_1.emitToAdmins)("client:registered", {
        id: user._id,
        name: getRepresentativeName(user),
        email: user.email,
        companyName: user.companyName,
        status: user.status,
        createdAt: user.createdAt,
    });
    const token = (0, jwt_js_1.generateToken)(user._id);
    const isApprovedClient = ["active", "verified"].includes(user.status);
    return res.status(201).json({
        success: true,
        message: isApprovedClient
            ? "Client account registered successfully."
            : "Registration submitted successfully. You are now logged in and can track your account approval status.",
        token,
        user: (0, exports.safeUser)(user),
    });
};
exports.verifyClientRegistrationOtp = verifyClientRegistrationOtp;
const forgotPassword = async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, message: "Email is required." });
    }
    const user = await User_js_1.default.findOne({ email: email.toLowerCase().trim() }).select("+passwordResetOtpHash");
    if (!user) {
        return res.json({ success: true, message: "If the email exists, an OTP will be sent." });
    }
    if (!canResendOtp(user.passwordResetLastSentAt)) {
        return res.status(429).json({
            success: false,
            message: `Please wait ${process.env.EMAIL_OTP_RESEND_SECONDS || 60} seconds before requesting another OTP.`,
        });
    }
    const otp = (0, generateOtp_js_1.generateOtp)();
    user.passwordResetOtpHash = await (0, generateOtp_js_1.hashOtp)(otp);
    user.passwordResetExpiresAt = getOtpExpiryDate();
    user.passwordResetAttempts = 0;
    user.passwordResetLastSentAt = new Date();
    await user.save();
    await (0, mailer_js_1.sendEmail)({
        to: user.email,
        subject: "OTLI Password Reset OTP",
        html: (0, emailTemplates_js_1.otpEmailTemplate)({
            title: "OTLI Password Reset",
            otp,
            message: "Use this OTP to reset your OTLI account password.",
        }),
    });
    return res.json({ success: true, message: "If the email exists, an OTP will be sent." });
};
exports.forgotPassword = forgotPassword;
const resetPassword = async (req, res) => {
    const { email, otp, password, confirmPassword } = req.body;
    if (!email || !otp || !password || !confirmPassword) {
        return res.status(400).json({ success: false, message: "Email, OTP, password, and confirm password are required." });
    }
    if (password !== confirmPassword) {
        return res.status(400).json({ success: false, message: "Password and confirm password do not match." });
    }
    const user = await User_js_1.default.findOne({ email: email.toLowerCase().trim() }).select("+password +passwordResetOtpHash");
    if (!user || !user.passwordResetOtpHash) {
        return res.status(400).json({ success: false, message: "Invalid password reset request." });
    }
    if (!user.passwordResetExpiresAt || user.passwordResetExpiresAt < new Date()) {
        return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
    }
    const maxAttempts = Number(process.env.EMAIL_OTP_MAX_ATTEMPTS || 5);
    if (user.passwordResetAttempts >= maxAttempts) {
        return res.status(429).json({ success: false, message: "Too many incorrect attempts. Please request a new OTP." });
    }
    const isValidOtp = await (0, generateOtp_js_1.compareOtp)(otp, user.passwordResetOtpHash);
    if (!isValidOtp) {
        user.passwordResetAttempts += 1;
        await user.save();
        return res.status(400).json({ success: false, message: "Invalid OTP." });
    }
    user.password = password;
    user.passwordResetOtpHash = "";
    user.passwordResetExpiresAt = null;
    user.passwordResetAttempts = 0;
    user.passwordResetLastSentAt = null;
    await user.save();
    return res.json({ success: true, message: "Password has been reset successfully." });
};
exports.resetPassword = resetPassword;
const changePassword = async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ success: false, message: "Current password, new password, and confirm password are required." });
    }
    if (newPassword !== confirmPassword) {
        return res.status(400).json({ success: false, message: "New password and confirm password do not match." });
    }
    if (String(newPassword).length < 6) {
        return res.status(400).json({ success: false, message: "New password must be at least 6 characters." });
    }
    const user = await User_js_1.default.findById(req.user._id).select("+password");
    if (!user) {
        return res.status(404).json({ success: false, message: "Account not found." });
    }
    const isCurrentPasswordValid = await user.matchPassword(currentPassword);
    if (!isCurrentPasswordValid) {
        return res.status(400).json({ success: false, message: "Current password is incorrect." });
    }
    const isSamePassword = await user.matchPassword(newPassword);
    if (isSamePassword) {
        return res.status(400).json({ success: false, message: "New password must be different from your current password." });
    }
    user.password = newPassword;
    await user.save();
    return res.json({ success: true, message: "Password changed successfully." });
};
exports.changePassword = changePassword;
const sendTestEmail = async (req, res) => {
    if (process.env.NODE_ENV !== "development") {
        return res.status(403).json({
            success: false,
            message: "Test email endpoint is only available in development.",
        });
    }
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, message: "Email is required." });
    }
    await (0, mailer_js_1.verifyMailer)();
    const info = await (0, mailer_js_1.sendEmail)({
        to: email.toLowerCase().trim(),
        subject: "OTLI SMTP Test Email",
        html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;">
        <h2>OTLI SMTP Test</h2>
        <p>If you received this email, Hostinger SMTP is working.</p>
        <p>Sent at: ${new Date().toISOString()}</p>
      </div>
    `,
        text: `OTLI SMTP Test. Sent at: ${new Date().toISOString()}`,
    });
    return res.json({
        success: true,
        message: "Test email was accepted by SMTP. Check Inbox, Spam, Promotions, or your Hostinger mail logs.",
        emailDebug: info,
    });
};
exports.sendTestEmail = sendTestEmail;
