"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const gateInRecordSchema = new mongoose_1.default.Schema({
    preAdvice: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "PreAdvice", required: true, unique: true, index: true },
    client: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    gateInNumber: { type: String, required: true, unique: true, index: true },
    containerNumber: { type: String, required: true, uppercase: true, trim: true, index: true },
    actualContainerNumber: { type: String, required: true, uppercase: true, trim: true },
    containerCondition: { type: String, default: "Good", trim: true },
    sealNumber: { type: String, default: "", trim: true },
    truckPlateNumber: { type: String, required: true, trim: true },
    driverName: { type: String, required: true, trim: true },
    driverLicenseNumber: { type: String, default: "", trim: true },
    damageRemarks: { type: String, default: "", trim: true },
    inspectionRemarks: { type: String, default: "", trim: true },
    status: { type: String, enum: ["completed", "cancelled"], default: "completed", index: true },
    completedAt: { type: Date, default: Date.now },
    encodedBy: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });
exports.default = mongoose_1.default.model("GateInRecord", gateInRecordSchema);
