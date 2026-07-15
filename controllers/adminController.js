"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.rejectClient = exports.approveClient = exports.deleteUser = exports.updateUser = exports.createAdminUser = exports.getUserById = exports.listClients = exports.listUsers = void 0;
const User_js_1 = __importDefault(require("../models/User.js"));
const authController_js_1 = require("./authController.js");
const socket_js_1 = require("../socket/socket.js");
const permissions_js_1 = require("../utils/permissions.js");
const listUsers = async (req, res) => {
    const { userType, status, search } = req.query;
    const filter = {};
    if (userType)
        filter.userType = userType;
    if (status)
        filter.status = status;
    if (search) {
        filter.$or = [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
            { companyName: { $regex: search, $options: "i" } },
        ];
    }
    const users = await User_js_1.default.find(filter).sort({ createdAt: -1 });
    return res.json({
        success: true,
        users: users.map(authController_js_1.safeUser),
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
const createAdminUser = async (req, res) => {
    const { name, email, password, role, permissions } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ success: false, message: "Name, email, and password are required." });
    }
    const exists = await User_js_1.default.findOne({ email: email.toLowerCase().trim() });
    if (exists) {
        return res.status(409).json({ success: false, message: "Email already exists." });
    }
    const selectedRole = role || "admin";
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
    const { name, email, status, role, permissions, companyName, companyAddress, phoneNumber, representativeFirstName, representativeMiddleName, representativeLastName, representativePosition, } = req.body;
    if (user.isLockedSeed) {
        user.name = name || user.name;
    }
    else {
        user.name = name ?? user.name;
        user.email = email ? email.toLowerCase().trim() : user.email;
        user.status = status ?? user.status;
        user.role = role ?? user.role;
        if (user.userType === "admin") {
            user.permissions = ["super_admin", "admin"].includes(user.role) ? (0, permissions_js_1.getAllAccessPermissions)() : (0, permissions_js_1.normalizePermissions)(permissions || user.permissions);
        }
    }
    user.companyName = companyName ?? user.companyName;
    user.companyAddress = companyAddress ?? user.companyAddress;
    user.phoneNumber = phoneNumber ?? user.phoneNumber;
    user.representativeFirstName = representativeFirstName ?? user.representativeFirstName;
    user.representativeMiddleName = representativeMiddleName ?? user.representativeMiddleName;
    user.representativeLastName = representativeLastName ?? user.representativeLastName;
    user.representativePosition = representativePosition ?? user.representativePosition;
    await user.save();
    const payload = (0, authController_js_1.safeUser)(user);
    (0, socket_js_1.emitToAdmins)("admin:user_updated", payload);
    (0, socket_js_1.emitToUser)(user._id, "account:updated", payload);
    return res.json({ success: true, message: "User updated successfully.", user: payload });
};
exports.updateUser = updateUser;
const deleteUser = async (req, res) => {
    const user = await User_js_1.default.findById(req.params.id);
    if (!user) {
        return res.status(404).json({ success: false, message: "User not found." });
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
    user.status = "verified";
    user.verifiedAt = new Date();
    user.rejectionReason = "";
    user.rejectedAt = null;
    await user.save();
    const payload = (0, authController_js_1.safeUser)(user);
    (0, socket_js_1.emitToAdmins)("client:approved", payload);
    (0, socket_js_1.emitToUser)(user._id, "client:approved", payload);
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
    return res.json({ success: true, message: "Client rejected successfully.", user: payload });
};
exports.rejectClient = rejectClient;
