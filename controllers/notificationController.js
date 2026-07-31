"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.markAllNotificationsRead = exports.markNotificationRead = exports.listClientNotifications = void 0;
const Notification_js_1 = __importDefault(require("../models/Notification.js"));
const notificationService_js_1 = require("../utils/notificationService.js");
const listClientNotifications = async (req, res) => {
    const requestedLimit = Number(req.query.limit || 30);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 30, 1), 100);
    const [notifications, unreadCount] = await Promise.all([
        Notification_js_1.default.find({ recipient: req.user._id }).sort({ createdAt: -1 }).limit(limit),
        Notification_js_1.default.countDocuments({ recipient: req.user._id, readAt: null }),
    ]);
    return res.json({
        success: true,
        notifications: notifications.map(notificationService_js_1.safeNotification),
        unreadCount,
    });
};
exports.listClientNotifications = listClientNotifications;
const markNotificationRead = async (req, res) => {
    const notification = await Notification_js_1.default.findOne({
        _id: req.params.id,
        recipient: req.user._id,
    });
    if (!notification) {
        return res.status(404).json({ success: false, message: "Notification not found." });
    }
    if (!notification.readAt) {
        notification.readAt = new Date();
        await notification.save();
    }
    return res.json({
        success: true,
        notification: (0, notificationService_js_1.safeNotification)(notification),
    });
};
exports.markNotificationRead = markNotificationRead;
const markAllNotificationsRead = async (req, res) => {
    const readAt = new Date();
    const result = await Notification_js_1.default.updateMany({
        recipient: req.user._id,
        readAt: null,
    }, { $set: { readAt } });
    return res.json({
        success: true,
        message: "All notifications marked as read.",
        updatedCount: result.modifiedCount || 0,
        readAt,
    });
};
exports.markAllNotificationsRead = markAllNotificationsRead;
