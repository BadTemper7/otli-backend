"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const mongoose_1 = __importDefault(require("mongoose"));
const User_js_1 = __importDefault(require("../models/User.js"));
const permissions_js_1 = require("../utils/permissions.js");
dotenv_1.default.config();
const seedSuperAdmin = async () => {
    try {
        await mongoose_1.default.connect(process.env.MONGODB_URI);
        const email = process.env.SUPER_ADMIN_EMAIL?.toLowerCase().trim();
        if (!email)
            throw new Error("SUPER_ADMIN_EMAIL is missing in .env");
        if (!process.env.SUPER_ADMIN_PASSWORD)
            throw new Error("SUPER_ADMIN_PASSWORD is missing in .env");
        const existing = await User_js_1.default.findOne({ email });
        if (existing) {
            existing.name = process.env.SUPER_ADMIN_NAME || "Super Admin";
            existing.userType = "admin";
            existing.role = "super_admin";
            existing.status = "active";
            existing.isEmailVerified = true;
            existing.isLockedSeed = true;
            existing.permissions = (0, permissions_js_1.getAllAccessPermissions)();
            existing.password = process.env.SUPER_ADMIN_PASSWORD;
            await existing.save();
            console.log("Locked Super Admin updated successfully.");
            process.exit(0);
        }
        await User_js_1.default.create({
            name: process.env.SUPER_ADMIN_NAME || "Super Admin",
            email,
            password: process.env.SUPER_ADMIN_PASSWORD,
            userType: "admin",
            role: "super_admin",
            status: "active",
            isEmailVerified: true,
            isLockedSeed: true,
            permissions: (0, permissions_js_1.getAllAccessPermissions)(),
        });
        console.log("Locked Super Admin seeded successfully.");
        process.exit(0);
    }
    catch (error) {
        console.error(error.message);
        process.exit(1);
    }
};
seedSuperAdmin();
