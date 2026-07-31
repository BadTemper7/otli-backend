"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createClientNotification = exports.safeNotification = void 0;
const Notification_js_1 = __importDefault(require("../models/Notification.js"));
const socket_js_1 = require("../socket/socket.js");
const safeNotification = (notification) => {
    const doc = notification?.toObject ? notification.toObject() : notification;
    if (!doc)
        return null;
    return {
        id: String(doc._id),
        type: doc.type || "general",
        title: doc.title || "Notification",
        message: doc.message || "",
        booking: doc.booking ? String(doc.booking?._id || doc.booking) : null,
        bookingReference: doc.bookingReference || "",
        containerNumber: doc.containerNumber || "",
        actionPath: doc.actionPath || "/booking-history",
        metadata: doc.metadata || {},
        isRead: Boolean(doc.readAt),
        readAt: doc.readAt || null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
};
exports.safeNotification = safeNotification;
const createClientNotification = async ({ recipient, type = "general", title, message, booking = null, bookingReference = "", containerNumber = "", actionPath = "/booking-history", metadata = {}, }) => {
    if (!recipient || !title || !message)
        return null;
    try {
        const notification = await Notification_js_1.default.create({
            recipient,
            type,
            title,
            message,
            booking: booking || null,
            bookingReference,
            containerNumber,
            actionPath,
            metadata,
        });
        const payload = (0, exports.safeNotification)(notification);
        (0, socket_js_1.emitToUser)(recipient, "notification:created", payload);
        return payload;
    }
    catch (error) {
        console.error("[notification] failed to create", {
            recipient: String(recipient || ""),
            title,
            error: error?.message || error,
        });
        return null;
    }
};
exports.createClientNotification = createClientNotification;
