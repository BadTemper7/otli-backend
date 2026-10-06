"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listSpecialRateClients = exports.deleteSpecialRate = exports.updateSpecialRate = exports.createSpecialRate = exports.getSpecialRate = exports.listSpecialRates = void 0;
const SpecialRate_js_1 = __importDefault(require("../models/SpecialRate.js"));
const BillingRate_js_1 = __importDefault(require("../models/BillingRate.js"));
const User_js_1 = __importDefault(require("../models/User.js"));
const socket_js_1 = require("../socket/socket.js");
const escapeRegex = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pageValues = (query = {}) => {
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(query.limit || query.pageSize) || 20, 1), 100);
    return { page, limit, skip: (page - 1) * limit };
};
const rateKey = (rate = {}) => [
    rate.rateType === "international" ? "international" : "local",
    String(rate.chargeCode || rate.description || rate._id || ""),
    String(rate.containerSize || "all"),
    String(rate.containerType || "all"),
    ["empty", "laden"].includes(rate.loadStatus) ? rate.loadStatus : "all",
].join(":");
const safeSpecialRate = (value) => {
    const doc = value?.toObject ? value.toObject() : value;
    return {
        id: String(doc._id),
        name: doc.name,
        clients: (doc.clients || []).map((client) => typeof client === "object" && client?._id ? ({ id: String(client._id), name: client.name, companyName: client.companyName, email: client.email }) : ({ id: String(client) })),
        transactions: (doc.transactions || []).map((item) => ({
            id: String(item._id || ""),
            transactionKey: item.transactionKey,
            billingRateId: item.billingRate ? String(item.billingRate) : null,
            chargeCode: item.chargeCode,
            description: item.description,
            rateType: item.rateType,
            containerSize: item.containerSize,
            containerType: item.containerType,
            loadStatus: item.loadStatus,
            unit: item.unit,
            unitLabel: item.unitLabel,
            specialRateAmount: Number(item.specialRateAmount) || 0,
        })),
        effectiveDate: doc.effectiveDate,
        effectiveTo: doc.effectiveTo || null,
        status: doc.status,
        notes: doc.notes || "",
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
};
const hydrateTransactions = async (transactions = []) => {
    if (!Array.isArray(transactions) || !transactions.length)
        throw Object.assign(new Error("Select at least one transaction."), { statusCode: 400 });
    const ids = transactions.map((item) => item.billingRateId || item.billingRate).filter(Boolean);
    const rates = await BillingRate_js_1.default.find({ _id: { $in: ids } }).lean();
    const byId = new Map(rates.map((rate) => [String(rate._id), rate]));
    return transactions.map((item) => {
        const rate = byId.get(String(item.billingRateId || item.billingRate || ""));
        if (!rate)
            throw Object.assign(new Error("One of the selected transactions no longer exists."), { statusCode: 400 });
        const specialRateAmount = Number(item.specialRateAmount);
        if (!Number.isFinite(specialRateAmount) || specialRateAmount < 0)
            throw Object.assign(new Error(`Enter a valid special rate for ${rate.description}.`), { statusCode: 400 });
        return {
            transactionKey: rateKey(rate),
            billingRate: rate._id,
            chargeCode: rate.chargeCode,
            description: rate.description,
            rateType: rate.rateType,
            containerSize: rate.containerSize || "all",
            containerType: rate.containerType || "all",
            loadStatus: ["empty", "laden"].includes(rate.loadStatus) ? rate.loadStatus : "all",
            unit: rate.unit || "per_container",
            unitLabel: rate.unitLabel || "",
            specialRateAmount,
        };
    });
};
const validateClients = async (clientIds = []) => {
    const unique = [...new Set((clientIds || []).map(String).filter(Boolean))];
    if (!unique.length)
        throw Object.assign(new Error("Select at least one client."), { statusCode: 400 });
    const count = await User_js_1.default.countDocuments({ _id: { $in: unique }, userType: "client" });
    if (count !== unique.length)
        throw Object.assign(new Error("One or more selected clients are invalid."), { statusCode: 400 });
    return unique;
};
const listSpecialRates = async (req, res) => {
    const { page, limit, skip } = pageValues(req.query);
    const query = {};
    if (req.query.status && req.query.status !== "all") query.status = req.query.status;
    if (req.query.clientId && req.query.clientId !== "all") query.clients = req.query.clientId;
    if (req.query.search) {
        const pattern = new RegExp(escapeRegex(String(req.query.search).trim()), "i");
        const matchingClients = await User_js_1.default.find({ userType: "client", $or: [{ name: pattern }, { companyName: pattern }, { email: pattern }] }).select("_id").limit(100).lean();
        query.$or = [
            { name: pattern },
            { notes: pattern },
            { "transactions.description": pattern },
            { "transactions.chargeCode": pattern },
            ...(matchingClients.length ? [{ clients: { $in: matchingClients.map((c) => c._id) } }] : []),
        ];
    }
    const [items, total] = await Promise.all([
        SpecialRate_js_1.default.find(query).populate("clients", "name companyName email").sort({ effectiveDate: -1, updatedAt: -1 }).skip(skip).limit(limit).lean(),
        SpecialRate_js_1.default.countDocuments(query),
    ]);
    return res.json({ success: true, specialRates: items.map(safeSpecialRate), pagination: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) } });
};
exports.listSpecialRates = listSpecialRates;
const getSpecialRate = async (req, res) => {
    const item = await SpecialRate_js_1.default.findById(req.params.id).populate("clients", "name companyName email").lean();
    if (!item) return res.status(404).json({ success: false, message: "Special Rate not found." });
    return res.json({ success: true, specialRate: safeSpecialRate(item) });
};
exports.getSpecialRate = getSpecialRate;
const createSpecialRate = async (req, res) => {
    const clients = await validateClients(req.body.clients);
    const transactions = await hydrateTransactions(req.body.transactions);
    const effectiveDate = new Date(req.body.effectiveDate);
    if (Number.isNaN(effectiveDate.getTime())) return res.status(400).json({ success: false, message: "Select a valid Effectivity Date." });
    const item = await SpecialRate_js_1.default.create({ name: req.body.name, clients, transactions, effectiveDate, effectiveTo: req.body.effectiveTo || null, status: req.body.status || "active", notes: req.body.notes || "", createdBy: req.user._id, updatedBy: req.user._id });
    const populated = await SpecialRate_js_1.default.findById(item._id).populate("clients", "name companyName email");
    (0, socket_js_1.emitToAdmins)("special_rate:created", safeSpecialRate(populated));
    return res.status(201).json({ success: true, message: "Special Rate created successfully.", specialRate: safeSpecialRate(populated) });
};
exports.createSpecialRate = createSpecialRate;
const updateSpecialRate = async (req, res) => {
    const item = await SpecialRate_js_1.default.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: "Special Rate not found." });
    if (req.body.clients) item.clients = await validateClients(req.body.clients);
    if (req.body.transactions) item.transactions = await hydrateTransactions(req.body.transactions);
    if (req.body.name !== undefined) item.name = req.body.name;
    if (req.body.effectiveDate !== undefined) {
        const date = new Date(req.body.effectiveDate);
        if (Number.isNaN(date.getTime())) return res.status(400).json({ success: false, message: "Select a valid Effectivity Date." });
        item.effectiveDate = date;
    }
    if (req.body.effectiveTo !== undefined) item.effectiveTo = req.body.effectiveTo || null;
    if (["active", "inactive"].includes(req.body.status)) item.status = req.body.status;
    if (req.body.notes !== undefined) item.notes = req.body.notes;
    item.updatedBy = req.user._id;
    await item.save();
    const populated = await SpecialRate_js_1.default.findById(item._id).populate("clients", "name companyName email");
    (0, socket_js_1.emitToAdmins)("special_rate:updated", safeSpecialRate(populated));
    return res.json({ success: true, message: "Special Rate updated successfully.", specialRate: safeSpecialRate(populated) });
};
exports.updateSpecialRate = updateSpecialRate;
const deleteSpecialRate = async (req, res) => {
    const item = await SpecialRate_js_1.default.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: "Special Rate not found." });
    item.status = "inactive";
    item.effectiveTo = item.effectiveTo || new Date();
    item.updatedBy = req.user._id;
    await item.save();
    (0, socket_js_1.emitToAdmins)("special_rate:deleted", { id: String(item._id) });
    return res.json({ success: true, message: "Special Rate deactivated. Historical billing remains unchanged." });
};
exports.deleteSpecialRate = deleteSpecialRate;
const listSpecialRateClients = async (req, res) => {
    const { page, limit, skip } = pageValues(req.query);
    const query = { userType: "client", status: { $in: ["active", "verified", "resubmitted"] } };
    if (req.query.search) {
        const pattern = new RegExp(escapeRegex(String(req.query.search).trim()), "i");
        query.$or = [{ name: pattern }, { companyName: pattern }, { email: pattern }];
    }
    const [items, total] = await Promise.all([
        User_js_1.default.find(query).select("name companyName email companyMarket status").sort({ companyName: 1, name: 1 }).skip(skip).limit(limit).lean(),
        User_js_1.default.countDocuments(query),
    ]);
    return res.json({ success: true, clients: items.map((c) => ({ id: String(c._id), name: c.name, companyName: c.companyName, email: c.email, companyMarket: c.companyMarket, status: c.status })), pagination: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) } });
};
exports.listSpecialRateClients = listSpecialRateClients;
