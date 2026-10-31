"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkRegistrationEmailAvailability = exports.submitClientManualRegistration = exports.sendTestEmail = exports.changePassword = exports.resetPassword = exports.forgotPassword = exports.resubmitRejectedClient = exports.verifyClientRegistrationOtp = exports.resendClientRegistrationOtp = exports.requestClientRegistrationOtp = exports.me = exports.login = exports.safeUser = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const mongoose_1 = __importDefault(require("mongoose"));
const User_js_1 = __importDefault(require("../models/User.js"));
const AuditLog_js_1 = __importDefault(require("../models/AuditLog.js"));
const PendingClient_js_1 = __importDefault(require("../models/PendingClient.js"));
const localFileStorage_js_1 = require("../utils/localFileStorage.js");
const mailer_js_1 = require("../config/mailer.js");
const registrationEmailLimit_js_1 = require("../utils/registrationEmailLimit.js");
const emailHistory = require("../utils/registrationEmailHistory.js");
const generateOtp_js_1 = require("../utils/generateOtp.js");
const jwt_js_1 = require("../utils/jwt.js");
const emailTemplates_js_1 = require("../utils/emailTemplates.js");
const socket_js_1 = require("../socket/socket.js");
const permissions_js_1 = require("../utils/permissions.js");
const legalPolicies_js_1 = require("../utils/legalPolicies.js");
const notificationService_js_1 = require("../utils/notificationService.js");
const documentLabels = {
    businessPermit: "Business Permit",
    birCertificate: "BIR Certificate",
    validId: "Valid ID",
    authorizationLetter: "Authorization Letter",
    otherDocument: "Other Document",
};
const requiredDocumentFields = ["businessPermit", "birCertificate", "validId"];
const getRegistrationValidationError = (req) => {
    const { companyName, companyAddress, companyType, phoneNumber, representativeFirstName,
        representativeLastName, representativePosition, email, password, confirmPassword,
        termsAccepted, privacyAccepted, representativeAuthorityConfirmed } = req.body || {};
    if ([companyName, companyAddress, companyType, phoneNumber, representativeFirstName,
        representativeLastName, representativePosition, email, password, confirmPassword]
        .some((value) => !String(value || "").trim())) {
        return "Please complete all required fields.";
    }
    if (password !== confirmPassword) return "Password and confirm password do not match.";
    if (String(password).length < 8) return "Password must be at least 8 characters.";
    if (!isAffirmativeConsent(termsAccepted) || !isAffirmativeConsent(privacyAccepted) ||
        !isAffirmativeConsent(representativeAuthorityConfirmed)) {
        return "You must accept the Terms and Conditions, consent to the Privacy Policy, and confirm your authority to register the company.";
    }
    const missing = requiredDocumentFields.filter((name) => !req.files?.[name]?.[0]);
    if (missing.length) return `Missing required documents: ${missing.map((name) => documentLabels[name]).join(", ")}.`;
    if (typeof email !== "string" || !/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(email.trim())) {
        return "Please provide a valid email address.";
    }
    return null;
};
const getRegistrationLegalConsent = (req) => ({
    termsAccepted: true,
    privacyAccepted: true,
    representativeAuthorityConfirmed: true,
    termsVersion: legalPolicies_js_1.TERMS_VERSION,
    privacyPolicyVersion: legalPolicies_js_1.PRIVACY_POLICY_VERSION,
    acceptedAt: new Date(),
    ipAddress: getRequestIpAddress(req),
    userAgent: String(req.headers?.["user-agent"] || "").slice(0, 500),
});

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
const otpResendWaitSeconds = (lastSentAt) => {
    if (!lastSentAt) return 0;
    const resendSeconds = Number(process.env.EMAIL_OTP_RESEND_SECONDS || 60);
    const elapsed = Date.now() - new Date(lastSentAt).getTime();
    return Math.max(0, Math.ceil((resendSeconds * 1000 - elapsed) / 1000));
};
const canResendOtp = (lastSentAt) => otpResendWaitSeconds(lastSentAt) === 0;
const replyOtpResendCooldown = (res, lastSentAt) => {
    const retryAfterSeconds = otpResendWaitSeconds(lastSentAt) || 1;
    res.set("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({
        success: false,
        code: "REGISTRATION_OTP_RESEND_COOLDOWN",
        retryAfterSeconds,
        message: `An OTP was recently requested. Please wait ${retryAfterSeconds} seconds or use the code you already received.`,
    });
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
        companyMarket: user.companyMarket === "international" ? "international" : "local",
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
        registrationMethod: user.registrationMethod || "email_otp",
        manualVerifiedAt: user.manualVerifiedAt || null,
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
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    };
};
exports.safeUser = safeUser;
const { timeRegistrationStage } = require("../utils/registrationTiming.js");

const uploadRegistrationDocuments = async ({ files, clientId }) => {
    // A registration can include five documents. Writing them concurrently
    // avoids serial filesystem delays during the OTP request.
    const fields = Object.keys(documentLabels).filter((fieldName) => files?.[fieldName]?.[0]);
    const results = await Promise.allSettled(fields.map(async (fieldName) => {
        const file = files[fieldName][0];
        const result = await (0, localFileStorage_js_1.saveUploadedFile)({
            file,
            clientId,
            category: "registration",
            prefix: fieldName,
        });
        return {
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
        };
    }));

    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
        // Do not leave partial documents behind when one write fails.
        await Promise.all(results.filter((result) => result.status === "fulfilled")
            .map((result) => (0, localFileStorage_js_1.deleteLocalFile)(result.value.publicId)
                .catch(() => undefined)));
        throw failed.reason;
    }
    return results.map((result) => result.value);
};
exports.uploadRegistrationDocuments = uploadRegistrationDocuments;
const login = async (req, res) => {
    // Low-volume diagnostic only: no credentials, email, IP, or token logged.
    // Requests taking >=1.5s identify whether lookup or bcrypt is the delay.
    const started = process.hrtime.bigint();
    let lookupMs = 0;
    let verifyMs = 0;
    try {
        const { email, password, loginType } = req.body;
        if (!email || !password) {
            return res.status(400).json({ success: false, message: "Email and password are required." });
        }
        const lookupStart = process.hrtime.bigint();
        const user = await User_js_1.default.findOne({ email: email.toLowerCase() }).select("+password");
        lookupMs = Math.round(Number(process.hrtime.bigint() - lookupStart) / 1e6);
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
        const verifyStart = process.hrtime.bigint();
        const isMatch = await user.matchPassword(password);
        verifyMs = Math.round(Number(process.hrtime.bigint() - verifyStart) / 1e6);
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
    }
    finally {
        const totalMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
        if (totalMs >= 1500) {
            console.warn(`[auth] slow login requestId=${req.apiRequestId || "untracked"} lookupMs=${lookupMs} verifyMs=${verifyMs} totalMs=${totalMs}`);
        }
    }
};
exports.login = login;
const me = async (req, res) => {
    return res.json({ success: true, user: (0, exports.safeUser)(req.user) });
};
exports.me = me;
// A stalled SMTP connection must not leave the registration page waiting for
// the provider indefinitely. We never retry an uncertain SMTP send automatically
// (it might have been accepted before the connection failed).
const handleRegistrationEmailFailure = (error, res, { recipient, flow } = {}) => {
    emailHistory.recordEmailEventSafely({
        eventType: emailHistory.classifySmtpFailure(error),
        recipient, flow, errorCode: error?.code,
    });
    const code = String(error?.code || "SMTP_ERROR");
    const safeCode = /^(E[A-Z_]{1,30}|SMTP_ERROR)$/.test(code) ? code : "SMTP_ERROR";
    console.warn(`[registration] OTP SMTP send not confirmed code=${safeCode}`);
    const retryAfterSeconds = Math.max(1, Number(process.env.EMAIL_OTP_RESEND_SECONDS || 60));
    res.set("Retry-After", String(retryAfterSeconds));
    return res.status(503).json({
        success: false,
        code: "REGISTRATION_OTP_DELIVERY_UNCONFIRMED",
        message: "OTP delivery could not be confirmed. Check your inbox (including spam). If no code arrives, please wait and use Resend OTP.",
        retryAfterSeconds,
    });
};

// Reserve a shared sending slot BEFORE saving/updating a registration OTP.
// When the SMTP account is at its limit, an existing valid OTP is not replaced.
const replyRegistrationEmailLimit = (res, error) => {
    const retryAfterSeconds = Math.max(1, Number(error?.retryAfterSeconds) || 12);
    res.set("Retry-After", String(retryAfterSeconds));
    res.set("Cache-Control", "no-store");
    return res.status(429).json({
        success: false,
        code: "REGISTRATION_EMAIL_LIMIT",
        retryAfterSeconds,
        manualReviewAvailable: true,
        message: retryAfterSeconds >= 3600
            ? "Registration email quota is temporarily full. You can submit for manual review now or try OTP later."
            : `Registration email service is busy. Try sending an OTP again in ${retryAfterSeconds} seconds, or submit for manual review.`,
    });
};
const checkRegistrationEmailAvailability = async (_req, res) => {
    res.set("Cache-Control", "no-store");
    const status = await (0, registrationEmailLimit_js_1.getRegistrationEmailStatus)();
    if (!status.allowed) return replyRegistrationEmailLimit(res, status);
    return res.json({ success: true, available: true });
};
exports.checkRegistrationEmailAvailability = checkRegistrationEmailAvailability;
const allowRegistrationOtpEmail = async (res, { recipient, flow }) => {
    try {
        await (0, registrationEmailLimit_js_1.reserveRegistrationEmailSlot)();
        emailHistory.recordEmailEventSafely({ eventType: "reserved", flow, recipient });
        return true;
    } catch (error) {
        if (error?.code !== "REGISTRATION_EMAIL_LIMIT") throw error;
        emailHistory.recordEmailEventSafely({ eventType: "rate_limited", flow });
        replyRegistrationEmailLimit(res, error);
        return false;
    }
};
const requestClientRegistrationOtp = async (req, res) => {
    const { companyName, companyAddress, companyType, companyTypeOther, phoneNumber, representativeFirstName, representativeMiddleName, representativeLastName, representativePosition, email, password, confirmPassword, termsAccepted, privacyAccepted, representativeAuthorityConfirmed, } = req.body;
    const validationError = getRegistrationValidationError(req);
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    const normalizedEmail = email.toLowerCase().trim();
    const existingUser = await timeRegistrationStage(req, "userLookupMs", () => User_js_1.default.findOne({ email: normalizedEmail }));
    if (existingUser) {
        return res.status(409).json({ success: false, message: "Email is already registered." });
    }
    const existingPending = await timeRegistrationStage(req, "pendingLookupMs", () => PendingClient_js_1.default.findOne({ email: normalizedEmail }).select("+otpHash"));
    if (existingPending && !canResendOtp(existingPending.otpLastSentAt)) {
        return replyOtpResendCooldown(res, existingPending.otpLastSentAt);
    }
    if (!(await timeRegistrationStage(req, "limitMs", () => allowRegistrationOtpEmail(res, { recipient: normalizedEmail, flow: "request_otp" })))) return;
    const reservedClientId = existingPending?.clientId || new mongoose_1.default.Types.ObjectId();
    const uploadedDocs = await timeRegistrationStage(req, "saveFilesMs", () => uploadRegistrationDocuments({
        files: req.files,
        clientId: reservedClientId,
    }));
    const otp = (0, generateOtp_js_1.generateOtp)();
    const otpHash = await (0, generateOtp_js_1.hashOtp)(otp);
    const passwordHash = await timeRegistrationStage(req, "hashPasswordMs", () => bcryptjs_1.default.hash(password, 10));
    await timeRegistrationStage(req, "savePendingMs", () => PendingClient_js_1.default.findOneAndUpdate({ email: normalizedEmail }, {
        clientId: reservedClientId,
        companyName,
        companyAddress,
        companyType,
        companyTypeOther: companyTypeOther || "",
        companyMarket: "local",
        phoneNumber,
        representativeFirstName,
        representativeMiddleName: representativeMiddleName || "",
        representativeLastName,
        representativePosition,
        email: normalizedEmail,
        password: passwordHash,
        documents: uploadedDocs,
        legalConsent: getRegistrationLegalConsent(req),
        otpHash,
        otpExpiresAt: getOtpExpiryDate(),
        otpAttempts: 0,
        otpLastSentAt: new Date(),
    }, { upsert: true, new: true, setDefaultsOnInsert: true }));
    try {
        await timeRegistrationStage(req, "smtpMs", () => (0, mailer_js_1.sendRegistrationOtpEmail)({
            to: normalizedEmail,
            html: (0, emailTemplates_js_1.otpEmailTemplate)({
                title: "OTLI Client Registration",
                otp,
                message: "Use this OTP to verify your email and submit your client registration.",
            }),
        }));
    } catch (error) {
        return handleRegistrationEmailFailure(error, res, { recipient: normalizedEmail, flow: "request_otp" });
    }
    emailHistory.recordEmailEventSafely({ eventType: "smtp_accepted", flow: "request_otp", recipient: normalizedEmail });
    return res.json({ success: true, message: "OTP has been sent to your email." });
};
exports.requestClientRegistrationOtp = requestClientRegistrationOtp;
// Fallback for genuine applicants when the configured SMTP quota has been
// exhausted. No email is sent and email ownership is NOT marked verified.
// Applicant remains pending until a human administrator reviews the documents.
const submitClientManualRegistration = async (req, res) => {
    const validationError = getRegistrationValidationError(req);
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    const normalizedEmail = req.body.email.toLowerCase().trim();
    if (await User_js_1.default.exists({ email: normalizedEmail })) {
        return res.status(409).json({ success: false, message: "Email is already registered. Please sign in or contact support." });
    }
    const pending = await PendingClient_js_1.default.findOne({ email: normalizedEmail });
    const clientId = pending?.clientId || new mongoose_1.default.Types.ObjectId();
    const uploadedDocs = await uploadRegistrationDocuments({ files: req.files, clientId });
    const { companyName, companyAddress, companyType, companyTypeOther, phoneNumber,
        representativeFirstName, representativeMiddleName, representativeLastName,
        representativePosition, password } = req.body;
    let user;
    try {
        user = await User_js_1.default.create({
            _id: clientId,
            name: `${representativeFirstName} ${representativeLastName}`.trim(),
            email: normalizedEmail,
            password,
            userType: "client",
            role: "client",
            registrationMethod: "manual_review",
            companyName, companyAddress, companyType,
            companyTypeOther: companyTypeOther || "",
            companyMarket: "local",
            phoneNumber, representativeFirstName,
            representativeMiddleName: representativeMiddleName || "",
            representativeLastName, representativePosition,
            documents: uploadedDocs,
            legalConsent: getRegistrationLegalConsent(req),
            status: "pending",
            isEmailVerified: false,
        });
    } catch (error) {
        await Promise.all(uploadedDocs.map((doc) => (0, localFileStorage_js_1.deleteLocalFile)(doc.publicId).catch(() => undefined)));
        if (error?.code === 11000) return res.status(409).json({ success: false, message: "Email is already registered." });
        throw error;
    }
    if (pending) {
        await PendingClient_js_1.default.deleteOne({ _id: pending._id }).catch(() => undefined);
        const unusedFiles = (pending.documents || []).filter((old) => !uploadedDocs.some((doc) => doc.publicId === old.publicId));
        await Promise.all(unusedFiles.map((doc) => (0, localFileStorage_js_1.deleteLocalFile)(doc.publicId).catch(() => undefined)));
    }
    const payload = (0, exports.safeUser)(user);
    (0, socket_js_1.emitToAdmins)("client:registered", {
        id: user._id, name: getRepresentativeName(user), email: user.email,
        companyName: user.companyName, status: "pending", createdAt: user.createdAt,
    });
    const token = (0, jwt_js_1.generateToken)(user._id);
    return res.status(201).json({
        success: true,
        message: "Registration submitted for manual review. No email OTP was sent. Your account cannot use booking services until an administrator verifies your details.",
        token,
        user: payload,
    });
};
exports.submitClientManualRegistration = submitClientManualRegistration;
const resendClientRegistrationOtp = async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, message: "Email is required." });
    }
    if (typeof email !== "string" || !/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(email.trim())) {
        return res.status(400).json({ success: false, message: "Please provide a valid email address." });
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
        return replyOtpResendCooldown(res, pending.otpLastSentAt);
    }
    if (!(await timeRegistrationStage(req, "limitMs", () => allowRegistrationOtpEmail(res, { recipient: normalizedEmail, flow: "resend_otp" })))) return;
    const otp = (0, generateOtp_js_1.generateOtp)();
    pending.otpHash = await (0, generateOtp_js_1.hashOtp)(otp);
    pending.otpExpiresAt = getOtpExpiryDate();
    pending.otpAttempts = 0;
    pending.otpLastSentAt = new Date();
    await timeRegistrationStage(req, "savePendingMs", () => pending.save());
    try {
        await timeRegistrationStage(req, "smtpMs", () => (0, mailer_js_1.sendRegistrationOtpEmail)({
            to: normalizedEmail,
            html: (0, emailTemplates_js_1.otpEmailTemplate)({
                title: "OTLI Client Registration",
                otp,
                message: "Use this new OTP to verify your email and submit your client registration.",
            }),
        }));
    } catch (error) {
        return handleRegistrationEmailFailure(error, res, { recipient: normalizedEmail, flow: "resend_otp" });
    }
    emailHistory.recordEmailEventSafely({ eventType: "smtp_accepted", flow: "resend_otp", recipient: normalizedEmail });
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
        companyMarket: pending.companyMarket === "international" ? "international" : "local",
        phoneNumber: pending.phoneNumber,
        representativeFirstName: pending.representativeFirstName,
        representativeMiddleName: pending.representativeMiddleName,
        representativeLastName: pending.representativeLastName,
        representativePosition: pending.representativePosition,
        documents: pending.documents,
        legalConsent: pending.legalConsent,
        status: defaultClientStatus,
        isEmailVerified: true,
        registrationMethod: "email_otp",
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
// Account recovery by email is disabled to protect the single SMTP account.
// Signed-in users can still change their passwords using /change-password.
const forgotPassword = async (_req, res) => {
    return res.status(410).json({
        success: false,
        message: "Email password reset is unavailable. Please contact an administrator for account recovery.",
    });
};
exports.forgotPassword = forgotPassword;
const resetPassword = async (_req, res) => {
    return res.status(410).json({
        success: false,
        message: "Email password reset is unavailable. Please contact an administrator for account recovery.",
    });
};
exports.resetPassword = resetPassword;
const resubmitRejectedClient = async (req, res) => {
    const user = await User_js_1.default.findById(req.user._id);
    if (!user || user.userType !== "client") return res.status(404).json({ success: false, message: "Client account not found." });
    if (user.status !== "rejected") return res.status(400).json({ success: false, message: "Only rejected client accounts can be resubmitted." });
    const fields = ["companyName", "companyAddress", "companyType", "companyTypeOther", "phoneNumber", "representativeFirstName", "representativeMiddleName", "representativeLastName", "representativePosition"];
    for (const field of fields) {
        if (req.body[field] !== undefined) user[field] = String(req.body[field] || "").trim();
    }
    const uploadedDocs = await uploadRegistrationDocuments({ files: req.files, clientId: user._id });
    if (uploadedDocs.length) {
        const replacementTypes = new Set(uploadedDocs.map((doc) => doc.type));
        user.documents = [...(user.documents || []).filter((doc) => !replacementTypes.has(doc.type)), ...uploadedDocs];
    }
    const requiredFields = [user.companyName, user.companyAddress, user.companyType, user.phoneNumber, user.representativeFirstName, user.representativeLastName, user.representativePosition];
    if (requiredFields.some((value) => !String(value || "").trim())) return res.status(400).json({ success: false, message: "Complete all required company and representative details before resubmitting." });
    const missingDocuments = requiredDocumentFields.filter((fieldName) => !(user.documents || []).some((doc) => doc.type === fieldName));
    if (missingDocuments.length) return res.status(400).json({ success: false, message: `Missing required documents: ${missingDocuments.map((field) => documentLabels[field]).join(", ")}.` });
    user.name = getRepresentativeName(user);
    user.status = "resubmitted";
    user.resubmittedAt = new Date();
    user.rejectionReason = "";
    await user.save();
    const payload = (0, exports.safeUser)(user);
    (0, socket_js_1.emitToAdmins)("client:resubmitted", payload);
    (0, socket_js_1.emitToUser)(user._id, "client:resubmitted", payload);
    await (0, notificationService_js_1.createClientNotification)({
        recipient: user._id,
        type: "account_resubmitted",
        title: "Account resubmitted",
        message: "Your corrected registration was submitted and is waiting for admin verification.",
        actionPath: "/profile",
    });
    return res.json({ success: true, message: "Account resubmitted for verification.", user: payload });
};
exports.resubmitRejectedClient = resubmitRejectedClient;
const changePassword = async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ success: false, message: "Current password, new password, and confirm password are required." });
    }
    if (newPassword !== confirmPassword) {
        return res.status(400).json({ success: false, message: "New password and confirm password do not match." });
    }
    if (String(newPassword).length < 8) {
        return res.status(400).json({ success: false, message: "New password must be at least 8 characters." });
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
    if (user.userType === "admin") {
        try {
            await AuditLog_js_1.default.create({
                user: user._id,
                userName: user.name || "Administrator",
                userEmail: user.email || "",
                module: "security",
                action: "edit",
                method: req.method,
                path: req.originalUrl || req.path,
                recordId: String(user._id),
                description: "EDIT security: administrator password changed",
                metadata: {},
                ipAddress: req.ip || req.socket?.remoteAddress || "",
                userAgent: req.get("user-agent") || "",
            });
        }
        catch (error) {
            console.error("Password audit log write failed:", error.message);
        }
    }
    return res.json({ success: true, message: "Password changed successfully." });
};
exports.changePassword = changePassword;
const sendTestEmail = async (_req, res) => {
    return res.status(410).json({
        success: false,
        message: "Test email sending is disabled. Only client registration OTP emails are allowed.",
    });
};
exports.sendTestEmail = sendTestEmail;
