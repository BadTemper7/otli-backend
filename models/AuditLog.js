"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const auditLogSchema = new mongoose_1.default.Schema({
    user: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    userName: { type: String, default: "System", trim: true },
    userEmail: { type: String, default: "", trim: true },
    module: { type: String, required: true, trim: true, index: true },
    action: { type: String, enum: ["add", "edit", "delete"], required: true, index: true },
    method: { type: String, default: "" },
    path: { type: String, default: "", trim: true },
    recordId: { type: String, default: "", trim: true, index: true },
    description: { type: String, default: "", trim: true },
    metadata: { type: mongoose_1.default.Schema.Types.Mixed, default: {} },
    ipAddress: { type: String, default: "" },
    userAgent: { type: String, default: "" },
}, { timestamps: true });
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ module: 1, action: 1, createdAt: -1 });
exports.default = mongoose_1.default.model("AuditLog", auditLogSchema);
