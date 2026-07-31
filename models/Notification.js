"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const notificationSchema = new mongoose_1.default.Schema({
    recipient: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, default: "general", trim: true, index: true },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    booking: { type: mongoose_1.default.Schema.Types.ObjectId, ref: "Booking", default: null },
    bookingReference: { type: String, default: "", trim: true },
    containerNumber: { type: String, default: "", trim: true },
    actionPath: { type: String, default: "/booking-history", trim: true },
    metadata: { type: mongoose_1.default.Schema.Types.Mixed, default: () => ({}) },
    readAt: { type: Date, default: null, index: true },
}, { timestamps: true });
notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, readAt: 1, createdAt: -1 });
exports.default = mongoose_1.default.model("Notification", notificationSchema);
