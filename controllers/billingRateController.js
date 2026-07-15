"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listActiveBillingRates = exports.deleteBillingRate = exports.seedReferenceBillingRates = exports.updateBillingRate = exports.createBillingRate = exports.listBillingRates = exports.OTLI_REFERENCE_RATES = void 0;
const BillingRate_js_1 = __importDefault(require("../models/BillingRate.js"));
const socket_js_1 = require("../socket/socket.js");
const toNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};
exports.OTLI_REFERENCE_RATES = [
    {
        category: "container_yard_operation",
        billingScope: "base",
        description: "Lift In Charge",
        chargeCode: "LIFT_ON_20",
        unit: "per_teu",
        containerSize: "all",
        rateAmount: 500,
        sortOrder: 10,
        notes: "Reference: PHP 500 per 20 ft equivalent. A 40ft container is charged x2.",
    },
    {
        category: "container_yard_operation",
        billingScope: "base",
        description: "Lift Out Charge",
        chargeCode: "LIFT_OFF_20",
        unit: "per_teu",
        containerSize: "all",
        rateAmount: 500,
        sortOrder: 20,
        notes: "Reference: PHP 500 per 20 ft equivalent. A 40ft container is charged x2.",
    },
    {
        category: "container_yard_operation",
        billingScope: "display_only",
        description: "Total Handling per Container Cycle",
        chargeCode: "TOTAL_HANDLING_CYCLE_20",
        unit: "per_container",
        containerSize: "20",
        rateAmount: 1000,
        sortOrder: 30,
        notes: "Display reference only. This is the total of Lift In and Lift Out, so it is not added again to billing.",
    },
    {
        category: "container_yard_operation",
        billingScope: "storage",
        description: "Storage",
        chargeCode: "STORAGE_20_DAY",
        unit: "storage_day",
        containerSize: "20",
        rateAmount: 100,
        sortOrder: 40,
        notes: "Reference: per 20 ft container per day.",
    },
    {
        category: "container_yard_operation",
        billingScope: "storage",
        description: "Storage",
        chargeCode: "STORAGE_40_DAY",
        unit: "storage_day",
        containerSize: "40",
        rateAmount: 200,
        sortOrder: 50,
        notes: "Reference: per 40 ft container per day.",
    },
    {
        category: "container_yard_operation",
        billingScope: "display_only",
        description: "Congestion Surcharge",
        chargeCode: "CONGESTION_20",
        unit: "per_container",
        containerSize: "20",
        rateAmount: 100,
        sortOrder: 60,
        notes: "Display reference only by default. Change billing scope to Base Auto Charge if congestion should be billed automatically.",
    },
    {
        category: "container_yard_operation",
        billingScope: "display_only",
        description: "Congestion Surcharge",
        chargeCode: "CONGESTION_40",
        unit: "per_container",
        containerSize: "40",
        rateAmount: 200,
        sortOrder: 70,
        notes: "Display reference only by default. Change billing scope to Base Auto Charge if congestion should be billed automatically.",
    },
    {
        category: "stripping_stuffing",
        billingScope: "optional_stripping_stuffing",
        description: "Stripping / Stuffing (with Mano)",
        chargeCode: "STRIPPING_STUFFING_MANO_20",
        unit: "per_container",
        containerSize: "20",
        rateAmount: 4000,
        sortOrder: 80,
        notes: "Added only when the booking service is Stripping / Stuffing with Mano.",
    },
    {
        category: "stripping_stuffing",
        billingScope: "optional_stripping_stuffing",
        description: "Stripping / Stuffing (with Mano)",
        chargeCode: "STRIPPING_STUFFING_MANO_40",
        unit: "per_container",
        containerSize: "40",
        rateAmount: 8000,
        sortOrder: 90,
        notes: "Added only when the booking service is Stripping / Stuffing with Mano.",
    },
];
const normalizedUnitValues = new Set(["per_container", "per_teu", "per_day", "storage_day", "fixed"]);
const toChargeCode = (description = "", unitLabel = "") => {
    const code = `${description}_${unitLabel}`
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 100);
    return code || `RATE_${Date.now()}`;
};
const getDefaultUnitLabel = (unit = "per_container", containerSize = "all") => {
    if (unit === "per_teu")
        return "per 20 ft container";
    if (unit === "storage_day" || unit === "per_day") {
        return containerSize === "all" ? "per container/day" : `per ${containerSize} ft container/day`;
    }
    if (unit === "fixed")
        return "fixed charge";
    return containerSize === "all" ? "per container" : `per ${containerSize} ft container`;
};
const inferRateRules = ({ description = "", unitLabel = "", requestedUnit = "", currentRate = null } = {}) => {
    const descriptionText = String(description).trim().toLowerCase();
    const unitText = String(unitLabel).trim().toLowerCase();
    const combined = `${descriptionText} ${unitText}`;
    const sizeMatch = combined.match(/(?:^|\D)(20|40|45)(?:\D|$)/);
    let containerSize = sizeMatch?.[1] || currentRate?.containerSize || "all";
    const isLiftIn = /\blift\s*(in|on)\b/.test(descriptionText);
    const isLiftOut = /\blift\s*(out|off)\b/.test(descriptionText);
    const isLift = isLiftIn || isLiftOut;
    const isStorage = /\bstorage\b/.test(descriptionText) || /\/\s*day\b|\bper\s+day\b|\bdaily\b/.test(unitText);
    const isStrippingStuffing = /\bstripping\b|\bstuffing\b|\bmano\b/.test(descriptionText);
    const isTotalHandling = /\btotal\s+handling\b/.test(descriptionText);
    const isFixed = /\bfixed\b|\bflat\b/.test(unitText);
    let unit = normalizedUnitValues.has(requestedUnit) ? requestedUnit : currentRate?.unit || "per_container";
    if (isLift) {
        unit = "per_teu";
        containerSize = "all";
    }
    else if (isStorage) {
        unit = "storage_day";
    }
    else if (isFixed) {
        unit = "fixed";
    }
    else if (!normalizedUnitValues.has(requestedUnit)) {
        unit = "per_container";
    }
    let billingScope = currentRate?.billingScope || "base";
    if (isTotalHandling)
        billingScope = "display_only";
    else if (isStrippingStuffing)
        billingScope = "optional_stripping_stuffing";
    else if (isStorage)
        billingScope = "storage";
    else
        billingScope = "base";
    const category = isStrippingStuffing ? "stripping_stuffing" : (currentRate?.category || "container_yard_operation");
    let sortOrder = Number(currentRate?.sortOrder) || 100;
    if (isLiftIn)
        sortOrder = 10;
    else if (isLiftOut)
        sortOrder = 20;
    else if (isTotalHandling)
        sortOrder = 30;
    else if (isStorage && containerSize === "20")
        sortOrder = 40;
    else if (isStorage && containerSize === "40")
        sortOrder = 50;
    else if (/\bcongestion\b/.test(descriptionText) && containerSize === "20")
        sortOrder = 60;
    else if (/\bcongestion\b/.test(descriptionText) && containerSize === "40")
        sortOrder = 70;
    else if (isStrippingStuffing && containerSize === "20")
        sortOrder = 80;
    else if (isStrippingStuffing && containerSize === "40")
        sortOrder = 90;
    return {
        category,
        billingScope,
        unit,
        containerSize,
        containerType: currentRate?.containerType || "all",
        loadStatus: currentRate?.loadStatus || "all",
        sortOrder,
    };
};
const buildRatePayload = (body = {}, currentRate = null) => {
    const description = String(body.description ?? currentRate?.description ?? "").trim();
    const requestedUnit = normalizedUnitValues.has(body.unit) ? body.unit : "";
    const unitLabel = String(body.unitLabel
        ?? currentRate?.unitLabel
        ?? getDefaultUnitLabel(requestedUnit || currentRate?.unit, currentRate?.containerSize)).trim();
    const rules = inferRateRules({ description, unitLabel, requestedUnit, currentRate });
    return normalizeRatePayload({
        description,
        chargeCode: currentRate?.chargeCode || body.chargeCode || toChargeCode(description, unitLabel),
        unitLabel,
        ...rules,
        rateAmount: body.rateAmount ?? currentRate?.rateAmount ?? 0,
        freeDays: 0,
        minimumAmount: 0,
        effectiveDate: currentRate?.effectiveDate || new Date(),
        status: "active",
        notes: "",
    });
};
const safeRate = (rate) => {
    const doc = rate.toObject ? rate.toObject() : rate;
    return {
        id: String(doc._id),
        description: doc.description,
        chargeCode: doc.chargeCode,
        category: doc.category || "container_yard_operation",
        billingScope: doc.billingScope || "base",
        unit: doc.unit,
        unitLabel: doc.unitLabel || getDefaultUnitLabel(doc.unit, doc.containerSize),
        containerSize: doc.containerSize,
        containerType: doc.containerType,
        loadStatus: doc.loadStatus,
        rateAmount: Number(doc.rateAmount) || 0,
        freeDays: Number(doc.freeDays) || 0,
        minimumAmount: Number(doc.minimumAmount) || 0,
        effectiveDate: doc.effectiveDate,
        status: doc.status,
        notes: doc.notes || "",
        sortOrder: Number(doc.sortOrder) || 100,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
};
const normalizeRatePayload = (body = {}) => ({
    description: String(body.description || "").trim(),
    chargeCode: String(body.chargeCode || body.description || "").trim(),
    category: body.category || "container_yard_operation",
    billingScope: body.billingScope || "base",
    unit: body.unit || (body.billingScope === "storage" ? "storage_day" : "per_container"),
    unitLabel: String(body.unitLabel || getDefaultUnitLabel(body.unit || (body.billingScope === "storage" ? "storage_day" : "per_container"), String(body.containerSize || "all"))).trim(),
    containerSize: String(body.containerSize || "all"),
    containerType: body.containerType || "all",
    loadStatus: body.loadStatus || "all",
    rateAmount: toNumber(body.rateAmount, 0),
    freeDays: toNumber(body.freeDays, 0),
    minimumAmount: toNumber(body.minimumAmount, 0),
    effectiveDate: body.effectiveDate || new Date(),
    status: body.status || "active",
    notes: body.notes || "",
    sortOrder: toNumber(body.sortOrder, 100),
});
const listBillingRates = async (req, res) => {
    const { status, search, category } = req.query;
    const query = {};
    if (status && status !== "all")
        query.status = status;
    if (category && category !== "all")
        query.category = category;
    if (search) {
        const term = String(search).trim();
        query.$or = [
            { description: { $regex: term, $options: "i" } },
            { chargeCode: { $regex: term, $options: "i" } },
            { unitLabel: { $regex: term, $options: "i" } },
            { notes: { $regex: term, $options: "i" } },
        ];
    }
    const rates = await BillingRate_js_1.default.find(query).sort({ category: 1, sortOrder: 1, status: 1, effectiveDate: -1, createdAt: -1 }).limit(300);
    return res.json({ success: true, rates: rates.map(safeRate), referenceRates: exports.OTLI_REFERENCE_RATES });
};
exports.listBillingRates = listBillingRates;
const createBillingRate = async (req, res) => {
    const payload = buildRatePayload(req.body);
    if (!payload.description || !payload.unitLabel) {
        return res.status(400).json({ success: false, message: "Description and Unit are required." });
    }
    if (payload.rateAmount <= 0) {
        return res.status(400).json({ success: false, message: "Rate amount must be greater than zero." });
    }
    const rate = await BillingRate_js_1.default.create(payload);
    const safe = safeRate(rate);
    (0, socket_js_1.emitToAdmins)("billing_rate:created", safe);
    return res.status(201).json({ success: true, message: "Billing rate created successfully.", rate: safe });
};
exports.createBillingRate = createBillingRate;
const updateBillingRate = async (req, res) => {
    const rate = await BillingRate_js_1.default.findById(req.params.id);
    if (!rate)
        return res.status(404).json({ success: false, message: "Billing rate not found." });
    const payload = buildRatePayload(req.body, rate);
    if (!payload.description || !payload.unitLabel) {
        return res.status(400).json({ success: false, message: "Description and Unit are required." });
    }
    if (payload.rateAmount <= 0) {
        return res.status(400).json({ success: false, message: "Rate amount must be greater than zero." });
    }
    Object.assign(rate, payload);
    await rate.save();
    const safe = safeRate(rate);
    (0, socket_js_1.emitToAdmins)("billing_rate:updated", safe);
    return res.json({ success: true, message: "Billing rate updated successfully.", rate: safe });
};
exports.updateBillingRate = updateBillingRate;
const seedReferenceBillingRates = async (req, res) => {
    const effectiveDate = req.body?.effectiveDate || new Date().toISOString().slice(0, 10);
    const mode = req.body?.mode || "upsert";
    const createdOrUpdated = [];
    for (const template of exports.OTLI_REFERENCE_RATES) {
        const payload = normalizeRatePayload({
            ...template,
            effectiveDate,
            status: "active",
            containerType: "all",
            loadStatus: "all",
            freeDays: 0,
            minimumAmount: 0,
        });
        let rate = await BillingRate_js_1.default.findOne({ chargeCode: payload.chargeCode });
        if (rate && mode === "skip_existing") {
            createdOrUpdated.push(rate);
            continue;
        }
        if (rate) {
            Object.assign(rate, payload);
            await rate.save();
        }
        else {
            rate = await BillingRate_js_1.default.create(payload);
        }
        createdOrUpdated.push(rate);
    }
    const rates = await BillingRate_js_1.default.find({ chargeCode: { $in: exports.OTLI_REFERENCE_RATES.map((rate) => rate.chargeCode) } }).sort({ category: 1, sortOrder: 1 });
    (0, socket_js_1.emitToAdmins)("billing_rate:reference_applied", { count: rates.length, effectiveDate });
    return res.json({
        success: true,
        message: "OTLI reference rates have been applied to Rate Setup.",
        rates: rates.map(safeRate),
    });
};
exports.seedReferenceBillingRates = seedReferenceBillingRates;
const deleteBillingRate = async (req, res) => {
    const rate = await BillingRate_js_1.default.findById(req.params.id);
    if (!rate)
        return res.status(404).json({ success: false, message: "Billing rate not found." });
    const safe = safeRate(rate);
    await rate.deleteOne();
    (0, socket_js_1.emitToAdmins)("billing_rate:deleted", safe);
    return res.json({ success: true, message: "Billing rate deleted successfully." });
};
exports.deleteBillingRate = deleteBillingRate;
const listActiveBillingRates = async (req, res) => {
    const rates = await BillingRate_js_1.default.find({
        status: "active",
        effectiveDate: { $lte: new Date() },
    }).sort({ category: 1, sortOrder: 1, effectiveDate: -1, createdAt: -1 });
    const latestByCode = new Map();
    for (const rate of rates) {
        if (!latestByCode.has(rate.chargeCode))
            latestByCode.set(rate.chargeCode, rate);
    }
    return res.json({ success: true, rates: Array.from(latestByCode.values()).map(safeRate) });
};
exports.listActiveBillingRates = listActiveBillingRates;
