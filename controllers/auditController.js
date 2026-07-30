"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listAuditLogs = void 0;
const AuditLog_js_1 = require("../models/AuditLog.js");
const listAuditLogs = async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const query = {};
    if (req.query.module && req.query.module !== "all") query.module = req.query.module;
    if (req.query.action && req.query.action !== "all") query.action = req.query.action;
    if (req.query.search) {
        const pattern = new RegExp(String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        query.$or = [{ userName: pattern }, { userEmail: pattern }, { description: pattern }, { recordId: pattern }];
    }
    const [logs, total, modules] = await Promise.all([
        AuditLog_js_1.default.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        AuditLog_js_1.default.countDocuments(query),
        AuditLog_js_1.default.distinct("module"),
    ]);
    return res.json({
        success: true,
        logs: logs.map((log) => ({ ...log, id: String(log._id), user: log.user ? String(log.user) : "" })),
        modules: modules.sort(),
        pagination: { page, limit, total, pages: Math.max(Math.ceil(total / limit), 1) },
    });
};
exports.listAuditLogs = listAuditLogs;
