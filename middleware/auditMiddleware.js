"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditAdminMutations = void 0;
const AuditLog_js_1 = require("../models/AuditLog.js");

const ACTION_BY_METHOD = { POST: "add", PATCH: "edit", PUT: "edit", DELETE: "delete" };
const getModule = (path = "") => {
    const clean = String(path).split("?")[0].replace(/^\//, "");
    const first = clean.split("/")[0] || "admin";
    if (first === "bookings") {
        if (clean.includes("/gate-in")) return "gate-in";
        if (clean.includes("/gate-out") || clean.includes("/payment/cash")) return "gate-out";
        if (clean.includes("/payment/")) return "payment-verification";
        if (clean.includes("/additional-charges") || clean.includes("/congestion-surcharge")) return "billing";
    }
    const aliases = {
        "client-registrations": "client-verification",
        clients: "client-verification",
        users: "user-management",
        bookings: "bookings",
        "pre-advice-bookings": "pre-advice",
        "pre-advices": "pre-advice",
        "gate-in": "gate-in",
        yard: "yard-management",
        inventory: "inventory",
        "billing-rates": "rate-setup",
        "payment-types": "payment-types",
        reports: "reports",
        settings: "settings",
    };
    return aliases[first] || first.replaceAll("-", " ");
};
const sanitizeBody = (body = {}) => {
    const hidden = new Set(["password", "currentPassword", "newPassword", "confirmPassword", "token"]);
    return Object.fromEntries(Object.entries(body || {}).filter(([key]) => !hidden.has(key)).slice(0, 30));
};
const auditAdminMutations = (req, res, next) => {
    const action = ACTION_BY_METHOD[req.method];
    if (!action) return next();
    res.on("finish", () => {
        if (res.statusCode < 200 || res.statusCode >= 400) return;
        const user = req.user || {};
        const recordId = String(req.params?.id || req.params?.preAdviceId || req.body?.id || "");
        AuditLog_js_1.default.create({
            user: user._id || null,
            userName: user.name || user.companyName || "Administrator",
            userEmail: user.email || "",
            module: getModule(req.path),
            action,
            method: req.method,
            path: req.originalUrl || req.path,
            recordId,
            description: `${action.toUpperCase()} ${getModule(req.path)}${recordId ? ` record ${recordId}` : ""}`,
            metadata: sanitizeBody(req.body),
            ipAddress: req.ip || req.socket?.remoteAddress || "",
            userAgent: req.get("user-agent") || "",
        }).catch((error) => console.error("Audit log write failed:", error.message));
    });
    return next();
};
exports.auditAdminMutations = auditAdminMutations;
