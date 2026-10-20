"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setBookingCMAIdentity = exports.listCMAPaymentHistory = exports.recordCMAPayment = exports.updateCMABilling = exports.recomputeCMABilling = exports.getCMABilling = exports.listCMABillings = exports.deleteCMARate = exports.updateCMARate = exports.createCMARate = exports.listCMARates = exports.deleteCMAClient = exports.updateCMAClient = exports.createCMAClient = exports.listCMATruckerClients = exports.listCMAClients = void 0;
const CMAClient_js_1 = __importDefault(require("../models/CMAClient.js"));
const CMARate_js_1 = __importDefault(require("../models/CMARate.js"));
const CMABilling_js_1 = __importDefault(require("../models/CMABilling.js"));
const User_js_1 = __importDefault(require("../models/User.js"));
const Booking_js_1 = __importDefault(require("../models/Booking.js"));
const cmaService_js_1 = require("../utils/cmaService.js");
const socket_js_1 = require("../socket/socket.js");

const escapeRegex = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pageValues = (query = {}, max = 200) => {
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(query.limit || query.pageSize) || 50, 1), max);
    return { page, limit, skip: (page - 1) * limit };
};
const toId = (value) => String(value?._id || value || "");
const cleanLines = (value) => {
    const list = Array.isArray(value) ? value : String(value || "").split(/[\n,]/g);
    return [...new Set(list.map((item) => (0, cmaService_js_1.normalizeShippingLine)(item)).filter(Boolean))];
};
const safeCMAClient = (value, truckerCount = undefined) => {
    const doc = value?.toObject ? value.toObject() : value;
    return {
        id: String(doc._id), name: doc.name, code: doc.code,
        contactPerson: doc.contactPerson || "", email: doc.email || "", phoneNumber: doc.phoneNumber || "",
        address: doc.address || "", shippingLines: doc.shippingLines || [], status: doc.status,
        notes: doc.notes || "", truckerCount: truckerCount ?? doc.truckerCount ?? 0,
        createdAt: doc.createdAt, updatedAt: doc.updatedAt,
    };
};
const safeCMARate = (value) => {
    const doc = value?.toObject ? value.toObject() : value;
    const cma = doc.cmaClient && typeof doc.cmaClient === "object" && doc.cmaClient._id ? doc.cmaClient : null;
    return {
        id: String(doc._id), cmaClientId: cma ? String(cma._id) : (doc.cmaClient ? String(doc.cmaClient) : null),
        cmaClientName: cma?.name || "All CMA Clients", cmaClientCode: cma?.code || "",
        description: doc.description, chargeCode: doc.chargeCode, chargeType: doc.chargeType,
        rateType: doc.rateType, containerSize: doc.containerSize, containerType: doc.containerType, loadStatus: doc.loadStatus,
        unit: doc.unit, rateAmount: Number(doc.rateAmount) || 0, freeDays: Number(doc.freeDays) || 0,
        minimumAmount: Number(doc.minimumAmount) || 0, effectiveDate: doc.effectiveDate, effectiveTo: doc.effectiveTo || null,
        status: doc.status, sortOrder: Number(doc.sortOrder) || 100, notes: doc.notes || "", createdAt: doc.createdAt, updatedAt: doc.updatedAt,
    };
};
const summarizeLineItems = (items = []) => {
    const totals = { loloFee: 0, storageFee: 0, otherCharges: 0 };
    for (const item of items) {
        const amount = Number(item.amount) || 0;
        if (item.chargeType === "lolo") totals.loloFee += amount;
        else if (item.chargeType === "storage") totals.storageFee += amount;
        else totals.otherCharges += amount;
    }
    return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, Math.round(value * 100) / 100]));
};
const safeCMABilling = (value) => {
    const doc = value?.toObject ? value.toObject() : value;
    const cma = doc.cmaClient && typeof doc.cmaClient === "object" && doc.cmaClient._id ? doc.cmaClient : null;
    const trucker = doc.truckerClient && typeof doc.truckerClient === "object" && doc.truckerClient._id ? doc.truckerClient : null;
    const booking = doc.booking && typeof doc.booking === "object" && doc.booking._id ? doc.booking : null;
    const sums = summarizeLineItems(doc.lineItems || []);
    return {
        id: String(doc._id), billingReference: doc.billingReference,
        bookingId: booking ? String(booking._id) : toId(doc.booking),
        cmaClientId: cma ? String(cma._id) : toId(doc.cmaClient), cmaClientName: cma?.name || "", cmaClientCode: cma?.code || "",
        truckerClientId: trucker ? String(trucker._id) : toId(doc.truckerClient),
        truckerClientName: trucker?.name || "", truckerCompanyName: trucker?.companyName || "", truckerEmail: trucker?.email || "",
        bookingReference: doc.bookingReference || booking?.bookingReference || "", bookingNumber: doc.bookingNumber || booking?.bookingNumber || "",
        containerNumber: doc.containerNumber || booking?.containerNumber || "", containerSize: doc.containerSize, containerType: doc.containerType,
        containerLoadStatus: doc.containerLoadStatus, rateType: doc.rateType, shippingLine: doc.shippingLine || "",
        gateInAt: doc.gateInAt || null, gateOutAt: doc.gateOutAt || null,
        lineItems: (doc.lineItems || []).map((item) => ({
            id: String(item._id || ""), rateId: item.rate ? String(item.rate) : null, chargeCode: item.chargeCode,
            description: item.description, chargeType: item.chargeType, unit: item.unit,
            quantity: Number(item.quantity) || 0, rateAmount: Number(item.rateAmount) || 0,
            amount: Number(item.amount) || 0, serviceDate: item.serviceDate || null,
            billingPeriodStart: item.billingPeriodStart || null, billingPeriodEnd: item.billingPeriodEnd || null,
        })),
        ...sums, subtotal: Number(doc.subtotal) || 0, isVatApplicable: doc.isVatApplicable !== false,
        vatRate: Number(doc.vatRate) || 0, vatAmount: Number(doc.vatAmount) || 0, totalAmount: Number(doc.totalAmount) || 0,
        paidAmount: Number(doc.paidAmount) || 0, balanceDue: Number(doc.balanceDue) || 0, paymentStatus: doc.paymentStatus,
        payments: (doc.payments || []).map((payment) => ({
            id: String(payment._id || ""), amount: Number(payment.amount) || 0, paymentDate: payment.paymentDate,
            referenceNumber: payment.referenceNumber, paymentType: payment.paymentType || "", remarks: payment.remarks || "",
            recordedAt: payment.recordedAt,
        })),
        remarks: doc.remarks || "", billingStage: doc.billingStage, computedAt: doc.computedAt,
        createdAt: doc.createdAt, updatedAt: doc.updatedAt,
    };
};

const syncTruckerAssignments = async (cmaClientId, truckerClientIds = [], actorId) => {
    if (!Array.isArray(truckerClientIds)) return;
    const unique = [...new Set(truckerClientIds.map(String).filter(Boolean))];
    if (unique.length) {
        const validCount = await User_js_1.default.countDocuments({ _id: { $in: unique }, userType: "client" });
        if (validCount !== unique.length) {
            const error = new Error("One or more selected trucker clients are invalid.");
            error.statusCode = 400;
            throw error;
        }
    }
    await User_js_1.default.updateMany({ userType: "client", cmaClient: cmaClientId, ...(unique.length ? { _id: { $nin: unique } } : {}) }, {
        $set: { isCMATruckerClient: false, cmaClient: null, cmaAssignedAt: null, cmaAssignedBy: null },
    });
    if (unique.length) {
        await User_js_1.default.updateMany({ _id: { $in: unique }, userType: "client" }, {
            $set: { isCMATruckerClient: true, cmaClient: cmaClientId, cmaAssignedAt: new Date(), cmaAssignedBy: actorId },
        });
    }
};

const listCMAClients = async (req, res) => {
    const query = {};
    if (req.query.status && req.query.status !== "all") query.status = req.query.status;
    if (req.query.search) {
        const pattern = new RegExp(escapeRegex(String(req.query.search).trim()), "i");
        query.$or = [{ name: pattern }, { code: pattern }, { contactPerson: pattern }, { email: pattern }, { shippingLines: pattern }];
    }
    const clients = await CMAClient_js_1.default.find(query).sort({ status: 1, name: 1 }).lean();
    const counts = await User_js_1.default.aggregate([
        { $match: { userType: "client", isCMATruckerClient: true, cmaClient: { $ne: null } } },
        { $group: { _id: "$cmaClient", count: { $sum: 1 } } },
    ]);
    const byId = new Map(counts.map((item) => [String(item._id), item.count]));
    return res.json({ success: true, cmaClients: clients.map((client) => safeCMAClient(client, byId.get(String(client._id)) || 0)) });
};
exports.listCMAClients = listCMAClients;

const listCMATruckerClients = async (req, res) => {
    const query = { userType: "client", status: { $in: ["active", "verified", "resubmitted"] } };
    if (req.query.search) {
        const pattern = new RegExp(escapeRegex(String(req.query.search).trim()), "i");
        query.$or = [{ name: pattern }, { companyName: pattern }, { email: pattern }];
    }
    const users = await User_js_1.default.find(query).select("name companyName email phoneNumber status isCMATruckerClient cmaClient").populate("cmaClient", "name code").sort({ companyName: 1, name: 1 }).limit(2000).lean();
    return res.json({ success: true, truckerClients: users.map((user) => ({
        id: String(user._id), name: user.name, companyName: user.companyName || "", email: user.email, phoneNumber: user.phoneNumber || "", status: user.status,
        isCMATruckerClient: Boolean(user.isCMATruckerClient), cmaClientId: user.cmaClient?._id ? String(user.cmaClient._id) : null,
        cmaClientName: user.cmaClient?.name || "", cmaClientCode: user.cmaClient?.code || "",
    })) });
};
exports.listCMATruckerClients = listCMATruckerClients;

const createCMAClient = async (req, res) => {
    if (!String(req.body.name || "").trim()) return res.status(400).json({ success: false, message: "CMA Client name is required." });
    const client = await CMAClient_js_1.default.create({
        name: req.body.name, code: req.body.code || req.body.name, contactPerson: req.body.contactPerson || "",
        email: req.body.email || "", phoneNumber: req.body.phoneNumber || "", address: req.body.address || "",
        shippingLines: cleanLines(req.body.shippingLines), status: req.body.status || "active", notes: req.body.notes || "",
        createdBy: req.user._id, updatedBy: req.user._id,
    });
    await syncTruckerAssignments(client._id, req.body.truckerClientIds, req.user._id);
    (0, socket_js_1.emitToAdmins)("cma_client:created", safeCMAClient(client));
    return res.status(201).json({ success: true, message: "CMA Client registered successfully.", cmaClient: safeCMAClient(client) });
};
exports.createCMAClient = createCMAClient;

const updateCMAClient = async (req, res) => {
    const client = await CMAClient_js_1.default.findById(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: "CMA Client not found." });
    for (const field of ["name", "code", "contactPerson", "email", "phoneNumber", "address", "notes"]) {
        if (req.body[field] !== undefined) client[field] = req.body[field];
    }
    if (req.body.shippingLines !== undefined) client.shippingLines = cleanLines(req.body.shippingLines);
    if (["active", "inactive"].includes(req.body.status)) client.status = req.body.status;
    client.updatedBy = req.user._id;
    await client.save();
    if (req.body.truckerClientIds !== undefined) await syncTruckerAssignments(client._id, req.body.truckerClientIds, req.user._id);
    (0, socket_js_1.emitToAdmins)("cma_client:updated", safeCMAClient(client));
    return res.json({ success: true, message: "CMA Client updated successfully.", cmaClient: safeCMAClient(client) });
};
exports.updateCMAClient = updateCMAClient;

const deleteCMAClient = async (req, res) => {
    const client = await CMAClient_js_1.default.findById(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: "CMA Client not found." });
    client.status = "inactive";
    client.updatedBy = req.user._id;
    await client.save();
    return res.json({ success: true, message: "CMA Client deactivated. Existing booking and billing records remain linked." });
};
exports.deleteCMAClient = deleteCMAClient;

const listCMARates = async (req, res) => {
    const query = {};
    if (req.query.status && req.query.status !== "all") query.status = req.query.status;
    if (req.query.cmaClientId && req.query.cmaClientId !== "all") query.cmaClient = req.query.cmaClientId;
    if (req.query.chargeType && req.query.chargeType !== "all") query.chargeType = req.query.chargeType;
    const rates = await CMARate_js_1.default.find(query).populate("cmaClient", "name code").sort({ sortOrder: 1, chargeType: 1, chargeCode: 1, effectiveDate: -1 }).lean();
    return res.json({ success: true, cmaRates: rates.map(safeCMARate) });
};
exports.listCMARates = listCMARates;

const ratePayload = (body, actorId, current = {}) => ({
    cmaClient: body.cmaClientId === "all" || body.cmaClientId === "" ? null : (body.cmaClientId ?? current.cmaClient ?? null),
    description: body.description ?? current.description,
    chargeCode: body.chargeCode ?? current.chargeCode,
    chargeType: body.chargeType ?? current.chargeType,
    rateType: body.rateType ?? current.rateType ?? "local",
    containerSize: body.containerSize ?? current.containerSize ?? "all",
    containerType: body.containerType ?? current.containerType ?? "all",
    loadStatus: body.loadStatus ?? current.loadStatus ?? "all",
    unit: body.unit ?? current.unit ?? "per_container",
    rateAmount: body.rateAmount ?? current.rateAmount ?? 0,
    freeDays: body.freeDays ?? current.freeDays ?? 0,
    minimumAmount: body.minimumAmount ?? current.minimumAmount ?? 0,
    effectiveDate: body.effectiveDate ?? current.effectiveDate ?? new Date(),
    effectiveTo: body.effectiveTo === "" ? null : (body.effectiveTo ?? current.effectiveTo ?? null),
    status: body.status ?? current.status ?? "active",
    sortOrder: body.sortOrder ?? current.sortOrder ?? 100,
    notes: body.notes ?? current.notes ?? "",
    updatedBy: actorId,
});
const createCMARate = async (req, res) => {
    if (!req.body.description || !req.body.chargeType) return res.status(400).json({ success: false, message: "Description and charge type are required." });
    const payload = ratePayload(req.body, req.user._id);
    payload.createdBy = req.user._id;
    const rate = await CMARate_js_1.default.create(payload);
    await rate.populate("cmaClient", "name code");
    return res.status(201).json({ success: true, message: "CMA Rate created successfully.", cmaRate: safeCMARate(rate) });
};
exports.createCMARate = createCMARate;
const updateCMARate = async (req, res) => {
    const rate = await CMARate_js_1.default.findById(req.params.id);
    if (!rate) return res.status(404).json({ success: false, message: "CMA Rate not found." });
    Object.assign(rate, ratePayload(req.body, req.user._id, rate));
    await rate.save();
    await rate.populate("cmaClient", "name code");
    return res.json({ success: true, message: "CMA Rate updated successfully.", cmaRate: safeCMARate(rate) });
};
exports.updateCMARate = updateCMARate;
const deleteCMARate = async (req, res) => {
    const rate = await CMARate_js_1.default.findById(req.params.id);
    if (!rate) return res.status(404).json({ success: false, message: "CMA Rate not found." });
    rate.status = "inactive";
    rate.effectiveTo = rate.effectiveTo || new Date();
    rate.updatedBy = req.user._id;
    await rate.save();
    return res.json({ success: true, message: "CMA Rate deactivated. Historical CMA billing remains intact." });
};
exports.deleteCMARate = deleteCMARate;

const billingQuery = (query) => {
    const result = {};
    if (query.paymentStatus && query.paymentStatus !== "all") result.paymentStatus = query.paymentStatus;
    if (query.cmaClientId && query.cmaClientId !== "all") result.cmaClient = query.cmaClientId;
    return result;
};
const populateCMABilling = (query) => query
    .populate("cmaClient", "name code")
    .populate("truckerClient", "name companyName email phoneNumber")
    .populate("booking", "bookingReference bookingNumber containerNumber status");
const listCMABillings = async (req, res) => {
    const { page, limit, skip } = pageValues(req.query);
    const query = billingQuery(req.query);
    if (req.query.search) {
        const pattern = new RegExp(escapeRegex(String(req.query.search).trim()), "i");
        const [cmas, users] = await Promise.all([
            CMAClient_js_1.default.find({ $or: [{ name: pattern }, { code: pattern }] }).select("_id").lean(),
            User_js_1.default.find({ userType: "client", $or: [{ name: pattern }, { companyName: pattern }, { email: pattern }] }).select("_id").lean(),
        ]);
        query.$or = [
            { billingReference: pattern }, { bookingReference: pattern }, { bookingNumber: pattern }, { containerNumber: pattern },
            ...(cmas.length ? [{ cmaClient: { $in: cmas.map((item) => item._id) } }] : []),
            ...(users.length ? [{ truckerClient: { $in: users.map((item) => item._id) } }] : []),
        ];
    }
    const [items, total] = await Promise.all([
        populateCMABilling(CMABilling_js_1.default.find(query)).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
        CMABilling_js_1.default.countDocuments(query),
    ]);
    return res.json({ success: true, cmaBillings: items.map(safeCMABilling), pagination: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) } });
};
exports.listCMABillings = listCMABillings;
const getCMABilling = async (req, res) => {
    const billing = await populateCMABilling(CMABilling_js_1.default.findById(req.params.id)).lean();
    if (!billing) return res.status(404).json({ success: false, message: "CMA Billing record not found." });
    return res.json({ success: true, cmaBilling: safeCMABilling(billing) });
};
exports.getCMABilling = getCMABilling;
const recomputeCMABilling = async (req, res) => {
    const billing = await CMABilling_js_1.default.findById(req.params.id);
    if (!billing) return res.status(404).json({ success: false, message: "CMA Billing record not found." });
    const booking = await Booking_js_1.default.findById(billing.booking);
    if (!booking) return res.status(404).json({ success: false, message: "Linked booking not found." });
    await (0, cmaService_js_1.computeCMABillingForBooking)(booking, { asOf: booking.outDate || new Date(), stage: booking.outDate ? "gate_out" : "gate_in", persist: true, updatedBy: req.user._id });
    const refreshed = await populateCMABilling(CMABilling_js_1.default.findById(billing._id)).lean();
    return res.json({ success: true, message: "CMA Billing recomputed from the current applicable rates.", cmaBilling: safeCMABilling(refreshed) });
};
exports.recomputeCMABilling = recomputeCMABilling;
const updateCMABilling = async (req, res) => {
    const billing = await CMABilling_js_1.default.findById(req.params.id);
    if (!billing) return res.status(404).json({ success: false, message: "CMA Billing record not found." });
    if (req.body.remarks !== undefined) billing.remarks = req.body.remarks;
    if (req.body.isVatApplicable !== undefined) billing.isVatApplicable = Boolean(req.body.isVatApplicable);
    if (req.body.vatRate !== undefined) {
        const rate = Number(req.body.vatRate);
        if (!Number.isFinite(rate) || rate < 0) return res.status(400).json({ success: false, message: "VAT rate must be a valid non-negative number." });
        billing.vatRate = rate;
    }
    billing.vatAmount = billing.isVatApplicable ? Math.round((Number(billing.subtotal) || 0) * (Number(billing.vatRate) || 0) * 100) / 100 : 0;
    billing.totalAmount = Math.round(((Number(billing.subtotal) || 0) + billing.vatAmount) * 100) / 100;
    billing.updatedBy = req.user._id;
    await billing.save();
    const refreshed = await populateCMABilling(CMABilling_js_1.default.findById(billing._id)).lean();
    return res.json({ success: true, message: "CMA Billing updated.", cmaBilling: safeCMABilling(refreshed) });
};
exports.updateCMABilling = updateCMABilling;
const recordCMAPayment = async (req, res) => {
    const billing = await CMABilling_js_1.default.findById(req.params.id);
    if (!billing) return res.status(404).json({ success: false, message: "CMA Billing record not found." });
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, message: "Enter a valid payment amount." });
    if (!String(req.body.referenceNumber || "").trim()) return res.status(400).json({ success: false, message: "Payment reference number is required." });
    const currentBalance = Math.max(Number(billing.totalAmount || 0) - (billing.payments || []).reduce((sum, item) => sum + (Number(item.amount) || 0), 0), 0);
    if (amount > currentBalance + 0.009) return res.status(400).json({ success: false, message: `Payment cannot exceed the CMA balance due of PHP ${currentBalance.toLocaleString()}.` });
    const paymentDate = req.body.paymentDate ? new Date(req.body.paymentDate) : new Date();
    if (Number.isNaN(paymentDate.getTime())) return res.status(400).json({ success: false, message: "Select a valid payment date." });
    billing.payments.push({ amount, paymentDate, referenceNumber: String(req.body.referenceNumber).trim(), paymentType: req.body.paymentType || "", remarks: req.body.remarks || "", recordedBy: req.user._id, recordedAt: new Date() });
    billing.updatedBy = req.user._id;
    await billing.save();
    const refreshed = await populateCMABilling(CMABilling_js_1.default.findById(billing._id)).lean();
    (0, socket_js_1.emitToAdmins)("cma_payment:recorded", safeCMABilling(refreshed));
    return res.status(201).json({ success: true, message: "CMA payment recorded successfully.", cmaBilling: safeCMABilling(refreshed) });
};
exports.recordCMAPayment = recordCMAPayment;

const listCMAPaymentHistory = async (req, res) => {
    const billings = await populateCMABilling(CMABilling_js_1.default.find(billingQuery(req.query))).sort({ updatedAt: -1 }).limit(2000).lean();
    let payments = [];
    for (const billing of billings) {
        const safe = safeCMABilling(billing);
        for (const payment of safe.payments || []) {
            payments.push({
                id: `${safe.id}:${payment.id}`, cmaBillingId: safe.id, billingReference: safe.billingReference,
                cmaClientId: safe.cmaClientId, cmaClientName: safe.cmaClientName, cmaClientCode: safe.cmaClientCode,
                truckerClientId: safe.truckerClientId, truckerClientName: safe.truckerClientName, truckerCompanyName: safe.truckerCompanyName,
                containerNumber: safe.containerNumber, bookingNumber: safe.bookingNumber, charges: safe.lineItems,
                amount: payment.amount, paymentStatus: safe.paymentStatus, paymentDate: payment.paymentDate,
                paymentReferenceNumber: payment.referenceNumber, paymentType: payment.paymentType, remarks: payment.remarks,
                recordedAt: payment.recordedAt,
            });
        }
    }
    payments.sort((a, b) => new Date(b.paymentDate || b.recordedAt || 0) - new Date(a.paymentDate || a.recordedAt || 0));
    if (req.query.search) {
        const needle = String(req.query.search).trim().toLowerCase();
        payments = payments.filter((item) => [item.cmaClientName, item.cmaClientCode, item.truckerClientName, item.truckerCompanyName, item.containerNumber, item.bookingNumber, item.billingReference, item.paymentReferenceNumber].some((value) => String(value || "").toLowerCase().includes(needle)));
    }
    return res.json({ success: true, payments });
};
exports.listCMAPaymentHistory = listCMAPaymentHistory;

const setBookingCMAIdentity = async (req, res) => {
    const booking = await Booking_js_1.default.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found." });
    let match;
    if (req.body.clear === true || req.body.cmaClientId === null) {
        match = await (0, cmaService_js_1.resolveCMAClientForBooking)({ clientId: booking.client, shippingLine: booking.shippingLine });
    } else {
        match = await (0, cmaService_js_1.resolveCMAClientForBooking)({ clientId: booking.client, shippingLine: booking.shippingLine, manualCmaClientId: req.body.cmaClientId });
    }
    (0, cmaService_js_1.applyCMAIdentity)(booking, match, req.user._id);
    await booking.save();
    if (booking.isCMASpecialClient && ["gate_in_approved", "stored_in_assigned_area", "gate_out_requested", "gate_out_approved", "completed_gate_out_done"].includes(booking.status)) {
        await (0, cmaService_js_1.computeCMABillingForBooking)(booking, { asOf: booking.outDate || new Date(), stage: booking.outDate ? "gate_out" : "gate_in", persist: true, updatedBy: req.user._id });
    }
    await booking.populate("cmaClient", "name code");
    return res.json({ success: true, message: booking.isCMASpecialClient ? "Booking marked as CMA Special Client." : "Booking CMA tag cleared; automatic matching was re-evaluated.", booking: {
        id: String(booking._id), isCMASpecialClient: booking.isCMASpecialClient, cmaClient: booking.cmaClient ? { id: String(booking.cmaClient._id || booking.cmaClient), name: booking.cmaClient.name || "", code: booking.cmaClient.code || "" } : null,
        cmaIdentificationSource: booking.cmaIdentificationSource,
    } });
};
exports.setBookingCMAIdentity = setBookingCMAIdentity;
