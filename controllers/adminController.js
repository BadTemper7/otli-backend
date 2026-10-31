"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createClient = exports.rejectClient = exports.approveClient = exports.deleteUser = exports.updateUser = exports.createAdminUser = exports.getUserById = exports.listClients = exports.listUsers = void 0;
const User_js_1 = __importDefault(require("../models/User.js"));
const PendingClient_js_1 = __importDefault(require("../models/PendingClient.js"));
const mongoose = require("mongoose");
const { deleteLocalFile } = require("../utils/localFileStorage.js");

const authController_js_1 = require("./authController.js");
const socket_js_1 = require("../socket/socket.js");
const permissions_js_1 = require("../utils/permissions.js");
const notificationService_js_1 = require("../utils/notificationService.js");
const listUsers = async (req, res) => {
    const { userType, status, search, role } = req.query;
    const filter = {};
    if (userType) filter.userType = userType;
    if (status && status !== "all") {
        const statuses = String(status).split(",").map((value) => value.trim()).filter(Boolean);
        if (statuses.length) filter.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
    }
    if (role && role !== "all") {
        const roles = String(role).split(",").map((value) => value.trim()).filter(Boolean);
        if (roles.length) filter.role = roles.length === 1 ? roles[0] : { $in: roles };
    }
    if (search) {
        const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(escaped, "i");
        filter.$or = [{ name: pattern }, { email: pattern }, { companyName: pattern }];
    }
    const hasPaging = req.query.page !== undefined || req.query.limit !== undefined || req.query.pageSize !== undefined;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit || req.query.pageSize) || 20, 1), 100);
    const query = User_js_1.default.find(filter).sort({ createdAt: -1 });
    if (hasPaging) query.skip((page - 1) * limit).limit(limit);
    const [users, total] = await Promise.all([query, User_js_1.default.countDocuments(filter)]);
    return res.json({
        success: true,
        users: users.map(authController_js_1.safeUser),
        pagination: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) },
    });
};
exports.listUsers = listUsers;
const listClients = async (req, res) => {
    req.query.userType = "client";
    return (0, exports.listUsers)(req, res);
};
exports.listClients = listClients;
const getUserById = async (req, res) => {
    const user = await User_js_1.default.findById(req.params.id);
    if (!user) {
        return res.status(404).json({ success: false, message: "User not found." });
    }
    return res.json({ success: true, user: (0, authController_js_1.safeUser)(user) });
};
exports.getUserById = getUserById;
// Administrator-assisted client onboarding; no OTP or any other email.
// Staff cannot activate or mark the email as verified through this endpoint.
const createClient = async (req, res) => {
    const body = req.body || {};
    const requiredFields = ["companyName", "companyAddress", "companyType", "phoneNumber",
        "representativeFirstName", "representativeLastName", "representativePosition", "email", "password"];
    if (requiredFields.some((field) => !String(body[field] || "").trim())) {
        return res.status(400).json({ success: false, message: "Complete all required client details and the initial password." });
    }
    const email = String(body.email).trim().toLowerCase();
    if (!/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(email)) {
        return res.status(400).json({ success: false, message: "Enter a valid email address." });
    }
    if (String(body.password).length < 8) {
        return res.status(400).json({ success: false, message: "Initial password must contain at least 8 characters." });
    }
    const requiredDocuments = ["businessPermit", "birCertificate", "validId"];
    if (requiredDocuments.some((field) => !req.files?.[field]?.[0])) {
        return res.status(400).json({ success: false, message: "Business Permit, BIR Certificate and Valid ID are required for admin-created clients." });
    }
    if (await User_js_1.default.exists({ email })) {
        return res.status(409).json({ success: false, message: "Client email already exists." });
    }
    const pending = await PendingClient_js_1.default.findOne({ email });
    const clientId = pending?.clientId || new mongoose.Types.ObjectId();
    const documents = await (0, authController_js_1.uploadRegistrationDocuments)({ files: req.files, clientId });
    let user;
    try {
        user = await User_js_1.default.create({
            _id: clientId,
            name: `${body.representativeFirstName} ${body.representativeLastName}`.trim(),
            email, password: body.password,
            userType: "client", role: "client", registrationMethod: "admin",
            companyName: body.companyName.trim(),
            companyAddress: body.companyAddress.trim(),
            companyType: body.companyType.trim(),
            companyTypeOther: String(body.companyTypeOther || "").trim(),
            companyMarket: "local",
            phoneNumber: body.phoneNumber.trim(),
            representativeFirstName: body.representativeFirstName.trim(),
            representativeMiddleName: String(body.representativeMiddleName || "").trim(),
            representativeLastName: body.representativeLastName.trim(),
            representativePosition: body.representativePosition.trim(),
            documents,
            // An administrator must not fabricate the applicant's online consent.
            legalConsent: pending?.legalConsent || {},
            status: "pending", isEmailVerified: false,
        });
    } catch (error) {
        await Promise.all(documents.map((doc) => deleteLocalFile(doc.publicId).catch(() => undefined)));
        if (error?.code === 11000) return res.status(409).json({ success: false, message: "Client email already exists." });
        throw error;
    }
    if (pending) {
        await PendingClient_js_1.default.deleteOne({ _id: pending._id }).catch(() => undefined);
        await Promise.all((pending.documents || []).map((doc) => deleteLocalFile(doc.publicId).catch(() => undefined)));
    }
    const payload = (0, authController_js_1.safeUser)(user);
    (0, socket_js_1.emitToAdmins)("client:registered", {
        id: user._id, name: user.name, email: user.email,
        companyName: user.companyName, status: user.status, createdAt: user.createdAt,
    });
    return res.status(201).json({
        success: true,
        message: "Client created as pending. No email was sent. Review the documents and complete manual verification before approving.",
        user: payload,
    });
};
exports.createClient = createClient;

const createAdminUser = async (req, res) => {
    const { name, email, password, role, permissions } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ success: false, message: "Name, email, and password are required." });
    }
    const exists = await User_js_1.default.findOne({ email: email.toLowerCase().trim() });
    if (exists) {
        return res.status(409).json({ success: false, message: "Email already exists." });
    }
    const allowedRoles = ["super_admin", "admin", "staff"];
    const selectedRole = allowedRoles.includes(role) ? role : "staff";
    const admin = await User_js_1.default.create({
        name,
        email: email.toLowerCase().trim(),
        password,
        userType: "admin",
        role: selectedRole,
        status: "active",
        isEmailVerified: true,
        permissions: ["super_admin", "admin"].includes(selectedRole) ? (0, permissions_js_1.getAllAccessPermissions)() : (0, permissions_js_1.normalizePermissions)(permissions),
    });
    (0, socket_js_1.emitToAdmins)("admin:user_created", (0, authController_js_1.safeUser)(admin));
    return res.status(201).json({
        success: true,
        message: "Admin account created successfully.",
        user: (0, authController_js_1.safeUser)(admin),
    });
};
exports.createAdminUser = createAdminUser;
const updateUser = async (req, res) => {
    const user = await User_js_1.default.findById(req.params.id);
    if (!user) {
        return res.status(404).json({ success: false, message: "User not found." });
    }
    const { name, email, status, role, permissions, companyName, companyAddress, companyType, companyTypeOther, phoneNumber, representativeFirstName, representativeMiddleName, representativeLastName, representativePosition, } = req.body;
    if (user.isLockedSeed) {
        user.name = name || user.name;
    }
    else {
        user.name = name ?? user.name;
        user.email = email ? email.toLowerCase().trim() : user.email;
        user.status = status ?? user.status;
        const allowedRoles = ["super_admin", "admin", "staff"];
        if (role !== undefined) {
            if (!allowedRoles.includes(role)) {
                return res.status(400).json({ success: false, message: "Invalid admin role." });
            }
            user.role = role;
        }
        if (user.userType === "admin") {
            user.permissions = ["super_admin", "admin"].includes(user.role) ? (0, permissions_js_1.getAllAccessPermissions)() : (0, permissions_js_1.normalizePermissions)(permissions || user.permissions);
        }
    }
    user.companyName = companyName ?? user.companyName;
    user.companyAddress = companyAddress ?? user.companyAddress;
    user.companyType = companyType ?? user.companyType;
    user.companyTypeOther = companyTypeOther ?? user.companyTypeOther;
    user.phoneNumber = phoneNumber ?? user.phoneNumber;
    user.representativeFirstName = representativeFirstName ?? user.representativeFirstName;
    user.representativeMiddleName = representativeMiddleName ?? user.representativeMiddleName;
    user.representativeLastName = representativeLastName ?? user.representativeLastName;
    user.representativePosition = representativePosition ?? user.representativePosition;
    await user.save();
    const payload = (0, authController_js_1.safeUser)(user);
    (0, socket_js_1.emitToAdmins)("admin:user_updated", payload);
    (0, socket_js_1.emitToUser)(user._id, "account:updated", payload);
    if (user.userType === "client") {
        await (0, notificationService_js_1.createClientNotification)({
            recipient: user._id,
            type: "account",
            title: "Account information updated",
            message: "Your One True Logistics account information was updated by an administrator.",
            actionPath: "/profile",
        });
    }
    return res.json({ success: true, message: "User updated successfully.", user: payload });
};
exports.updateUser = updateUser;
const deleteUser = async (req, res) => {
    const user = await User_js_1.default.findById(req.params.id);
    if (!user) {
        return res.status(404).json({ success: false, message: "User not found." });
    }
    if (String(user._id) === String(req.user?._id)) {
        return res.status(400).json({ success: false, message: "You cannot delete your own account." });
    }
    if (user.isLockedSeed) {
        return res.status(403).json({ success: false, message: "The seeded Super Admin account cannot be deleted." });
    }
    await User_js_1.default.deleteOne({ _id: user._id });
    (0, socket_js_1.emitToAdmins)("admin:user_deleted", { id: user._id });
    return res.json({ success: true, message: "User deleted successfully." });
};
exports.deleteUser = deleteUser;
const approveClient = async (req, res) => {
    const user = await User_js_1.default.findById(req.params.id);
    if (!user || user.userType !== "client") {
        return res.status(404).json({ success: false, message: "Client not found." });
    }
    if (["admin", "manual_review"].includes(user.registrationMethod)) {
        const required = ["businessPermit", "birCertificate", "validId"];
        const types = new Set((user.documents || []).map((doc) => doc.type));
        if (required.some((type) => !types.has(type))) {
            return res.status(400).json({ success: false, message: "Manual accounts require all three identity and company documents before approval." });
        }
        if (req.body?.confirmManualVerification !== true) {
            return res.status(400).json({
                success: false,
                code: "MANUAL_VERIFICATION_REQUIRED",
                message: "Confirm that you independently reviewed the applicant's documents, contact identity and required consent before approval.",
            });
        }
        user.manualVerifiedAt = new Date();
        user.manuallyVerifiedBy = req.user._id;
        // Keep isEmailVerified false: human review is not an email OTP.
    }
    user.status = "verified";
    user.verifiedAt = new Date();
    user.rejectionReason = "";
    user.rejectedAt = null;
    await user.save();
    const payload = (0, authController_js_1.safeUser)(user);
    (0, socket_js_1.emitToAdmins)("client:approved", payload);
    (0, socket_js_1.emitToUser)(user._id, "client:approved", payload);
    await (0, notificationService_js_1.createClientNotification)({
        recipient: user._id,
        type: "account_approved",
        title: "Client account approved",
        message: "Your account has been verified. Booking and rates modules are now available.",
        actionPath: "/",
    });
    return res.json({ success: true, message: "Client verified successfully.", user: payload });
};
exports.approveClient = approveClient;
const rejectClient = async (req, res) => {
    const user = await User_js_1.default.findById(req.params.id);
    if (!user || user.userType !== "client") {
        return res.status(404).json({ success: false, message: "Client not found." });
    }
    const { reason } = req.body;
    user.status = "rejected";
    user.rejectionReason = reason || "Client registration was rejected by admin.";
    user.rejectedAt = new Date();
    await user.save();
    const payload = (0, authController_js_1.safeUser)(user);
    (0, socket_js_1.emitToAdmins)("client:rejected", payload);
    (0, socket_js_1.emitToUser)(user._id, "client:rejected", payload);
    await (0, notificationService_js_1.createClientNotification)({
        recipient: user._id,
        type: "account_rejected",
        title: "Client registration requires correction",
        message: user.rejectionReason,
        actionPath: "/profile",
    });
    return res.json({ success: true, message: "Client rejected successfully.", user: payload });
};
exports.rejectClient = rejectClient;
