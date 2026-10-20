"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const cmaClientSchema = new mongoose_1.default.Schema({
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, uppercase: true, trim: true, unique: true, index: true },
    contactPerson: { type: String, default: "", trim: true },
    email: { type: String, default: "", lowercase: true, trim: true },
    phoneNumber: { type: String, default: "", trim: true },
    address: { type: String, default: "", trim: true },
    shippingLines: { type: [String], default: [] },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    notes: { type: String, default: "", trim: true },
    createdBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });
cmaClientSchema.index({ status: 1, name: 1 });
cmaClientSchema.index({ shippingLines: 1, status: 1 });
cmaClientSchema.pre("validate", function () {
    this.name = String(this.name || "").trim();
    this.code = String(this.code || this.name || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    this.shippingLines = [...new Set((this.shippingLines || [])
        .map((value) => String(value || "").trim().toUpperCase().replace(/\s+/g, " "))
        .filter(Boolean))];
});
exports.default = mongoose_1.default.model("CMAClient", cmaClientSchema);
