"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deletePaymentType = exports.updatePaymentType = exports.createPaymentType = exports.listActivePaymentTypes = exports.listPaymentTypes = exports.safePaymentType = void 0;
const PaymentType_js_1 = __importDefault(require("../models/PaymentType.js"));
const localFileStorage_js_1 = require("../utils/localFileStorage.js");
const socket_js_1 = require("../socket/socket.js");
const toNumber = (value, fallback = 100) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};
const safePaymentType = (paymentType) => {
    const doc = paymentType?.toObject ? paymentType.toObject() : paymentType;
    if (!doc)
        return null;
    return {
        id: String(doc._id),
        type: doc.type,
        name: doc.name,
        bankName: doc.bankName || "",
        accountNumber: doc.accountNumber,
        accountName: doc.accountName,
        qrUrl: doc.qrSecureUrl || doc.qrUrl || "",
        instructions: doc.instructions || "",
        status: doc.status,
        sortOrder: Number.isFinite(Number(doc.sortOrder)) ? Number(doc.sortOrder) : 100,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
};
exports.safePaymentType = safePaymentType;
const ensureDefaultCashPaymentType = async () => {
    const existing = await PaymentType_js_1.default.findOne({ type: "cash", name: /^Cash$/i });
    if (existing) return existing;
    return PaymentType_js_1.default.create({
        type: "cash",
        name: "Cash",
        bankName: "",
        accountNumber: "",
        accountName: "",
        instructions: "Pay cash at the authorized cashier and keep the official receipt.",
        status: "active",
        sortOrder: 0,
    });
};
const normalizePayload = (body = {}) => ({
    type: ["cash", "bank", "ewallet"].includes(body.type) ? body.type : "cash",
    name: String(body.name || "").trim(),
    bankName: String(body.bankName || "").trim(),
    accountNumber: String(body.accountNumber || "").trim(),
    accountName: String(body.accountName || "").trim(),
    qrUrl: String(body.qrUrl || "").trim(),
    instructions: String(body.instructions || "").trim(),
    status: body.status === "inactive" ? "inactive" : "active",
    sortOrder: toNumber(body.sortOrder, 100),
});
const validatePayload = (payload) => {
    if (!payload.name)
        return "Payment name is required.";
    if (payload.type !== "cash" && !payload.accountNumber)
        return "Account number is required.";
    if (payload.type !== "cash" && !payload.accountName)
        return "Account owner name is required.";
    if (payload.type === "bank" && !payload.bankName)
        return "Bank name is required for bank payment types.";
    return "";
};
const uploadQr = async (file, paymentName) => {
    if (!file)
        return null;
    const result = await (0, localFileStorage_js_1.saveUploadedFile)({
        file,
        clientId: "system",
        category: "payment-type",
        prefix: paymentName || "qr",
    });
    return {
        qrUrl: result.url || "",
        qrSecureUrl: result.secureUrl || result.url || "",
        qrPublicId: result.publicId || "",
    };
};
const listPaymentTypes = async (req, res) => {
    await ensureDefaultCashPaymentType();
    const { status, type, search } = req.query;
    const query = {};
    if (status && status !== "all")
        query.status = status;
    if (type && type !== "all")
        query.type = type;
    if (search) {
        const term = String(search).trim();
        query.$or = [
            { name: { $regex: term, $options: "i" } },
            { bankName: { $regex: term, $options: "i" } },
            { accountName: { $regex: term, $options: "i" } },
            { accountNumber: { $regex: term, $options: "i" } },
        ];
    }
    const paymentTypes = await PaymentType_js_1.default.find(query).sort({ status: 1, sortOrder: 1, type: 1, name: 1 });
    return res.json({ success: true, paymentTypes: paymentTypes.map(exports.safePaymentType) });
};
exports.listPaymentTypes = listPaymentTypes;
const listActivePaymentTypes = async (req, res) => {
    await ensureDefaultCashPaymentType();
    const paymentTypes = await PaymentType_js_1.default.find({ status: "active" }).sort({ sortOrder: 1, type: 1, name: 1 });
    return res.json({ success: true, paymentTypes: paymentTypes.map(exports.safePaymentType) });
};
exports.listActivePaymentTypes = listActivePaymentTypes;
const createPaymentType = async (req, res) => {
    const payload = normalizePayload(req.body);
    const validationError = validatePayload(payload);
    if (validationError)
        return res.status(400).json({ success: false, message: validationError });
    const qr = await uploadQr(req.file, payload.name);
    const paymentType = await PaymentType_js_1.default.create({ ...payload, ...(qr || {}) });
    const safe = (0, exports.safePaymentType)(paymentType);
    (0, socket_js_1.emitToAdmins)("payment_type:created", safe);
    return res.status(201).json({ success: true, message: "Payment type added successfully.", paymentType: safe });
};
exports.createPaymentType = createPaymentType;
const updatePaymentType = async (req, res) => {
    const paymentType = await PaymentType_js_1.default.findById(req.params.id);
    if (!paymentType)
        return res.status(404).json({ success: false, message: "Payment type not found." });
    const payload = normalizePayload({ ...paymentType.toObject(), ...req.body });
    const validationError = validatePayload(payload);
    if (validationError)
        return res.status(400).json({ success: false, message: validationError });
    const previousPublicId = paymentType.qrPublicId;
    const qr = await uploadQr(req.file, payload.name);
    Object.assign(paymentType, payload, qr || {});
    await paymentType.save();
    if (qr && previousPublicId && previousPublicId !== paymentType.qrPublicId) {
        await (0, localFileStorage_js_1.deleteLocalFile)(previousPublicId).catch(() => null);
    }
    const safe = (0, exports.safePaymentType)(paymentType);
    (0, socket_js_1.emitToAdmins)("payment_type:updated", safe);
    return res.json({ success: true, message: "Payment type updated successfully.", paymentType: safe });
};
exports.updatePaymentType = updatePaymentType;
const deletePaymentType = async (req, res) => {
    const paymentType = await PaymentType_js_1.default.findById(req.params.id);
    if (!paymentType)
        return res.status(404).json({ success: false, message: "Payment type not found." });
    const safe = (0, exports.safePaymentType)(paymentType);
    if (paymentType.qrPublicId)
        await (0, localFileStorage_js_1.deleteLocalFile)(paymentType.qrPublicId).catch(() => null);
    await paymentType.deleteOne();
    (0, socket_js_1.emitToAdmins)("payment_type:deleted", safe);
    return res.json({ success: true, message: "Payment type deleted successfully." });
};
exports.deletePaymentType = deletePaymentType;
