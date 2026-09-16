"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getClientRateChangeNotice = exports.listActiveBillingRates = exports.deleteBillingRate = exports.seedReferenceBillingRates = exports.updateBillingRate = exports.createBillingRate = exports.listBillingRates = exports.OTLI_REFERENCE_RATES = void 0;
const BillingRate_js_1 = __importDefault(require("../models/BillingRate.js"));
const Notification_js_1 = __importDefault(require("../models/Notification.js"));
const notificationService_js_1 = require("../utils/notificationService.js");
const socket_js_1 = require("../socket/socket.js");
const toNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};
const normalizeRateType = (value) => String(value || "").toLowerCase() === "international" ? "international" : "local";
const normalizeLoadStatus = (value) => {
    const normalized = String(value || "all").trim().toLowerCase();
    if (normalized === "loaded")
        return "laden";
    return ["all", "empty", "laden"].includes(normalized) ? normalized : "all";
};
const getChargeType = (rate = {}) => {
    const text = `${rate.chargeCode || ""} ${rate.description || ""}`.trim().toLowerCase();
    if (/lift[_\s-]*(on|in)/.test(text))
        return "lift_on";
    if (/lift[_\s-]*(off|out)/.test(text))
        return "lift_off";
    if (/storage/.test(text))
        return "storage";
    if (/total[_\s-]*handling/.test(text))
        return "total_handling";
    if (/congestion/.test(text))
        return "congestion";
    return "other";
};
const isDocumentationRate = (rate = {}) => /documentation|document_fee|doc_fee/.test(`${rate.description || ""} ${rate.chargeCode || ""}`.toLowerCase());
exports.OTLI_REFERENCE_RATES = [
    {
        rateType: "local", category: "container_yard_operation", billingScope: "base",
        description: "Lift On", chargeCode: "LIFT_ON_20", unit: "per_container", containerSize: "20",
        rateAmount: 500, sortOrder: 10, notes: "Applied only to 20ft containers.",
    },
    {
        rateType: "local", category: "container_yard_operation", billingScope: "base",
        description: "Lift On", chargeCode: "LIFT_ON_40", unit: "per_container", containerSize: "40",
        rateAmount: 1000, sortOrder: 11, notes: "Applied only to 40ft containers.",
    },
    {
        rateType: "local", category: "container_yard_operation", billingScope: "base",
        description: "Lift Off", chargeCode: "LIFT_OFF_20", unit: "per_container", containerSize: "20",
        rateAmount: 500, sortOrder: 20, notes: "Applied only to 20ft containers.",
    },
    {
        rateType: "local", category: "container_yard_operation", billingScope: "base",
        description: "Lift Off", chargeCode: "LIFT_OFF_40", unit: "per_container", containerSize: "40",
        rateAmount: 1000, sortOrder: 21, notes: "Applied only to 40ft containers.",
    },
    {
        rateType: "local", category: "container_yard_operation", billingScope: "display_only",
        description: "Total Handling per Container Cycle", chargeCode: "TOTAL_HANDLING_CYCLE_20", unit: "per_container", containerSize: "20",
        rateAmount: 1000, sortOrder: 30, notes: "Display reference only. Lift On and Lift Off are billed separately.",
    },
    {
        rateType: "local", category: "container_yard_operation", billingScope: "display_only",
        description: "Total Handling per Container Cycle", chargeCode: "TOTAL_HANDLING_CYCLE_40", unit: "per_container", containerSize: "40",
        rateAmount: 2000, sortOrder: 31, notes: "Display reference only. Lift On and Lift Off are billed separately.",
    },
    {
        rateType: "local", category: "container_yard_operation", billingScope: "storage",
        description: "Storage", chargeCode: "STORAGE_20_DAY", unit: "storage_day", containerSize: "20",
        rateAmount: 100, sortOrder: 40, notes: "Per 20ft container per day.",
    },
    {
        rateType: "local", category: "container_yard_operation", billingScope: "storage",
        description: "Storage", chargeCode: "STORAGE_40_DAY", unit: "storage_day", containerSize: "40",
        rateAmount: 200, sortOrder: 50, notes: "Per 40ft container per day.",
    },
    {
        rateType: "local", category: "container_yard_operation", billingScope: "display_only",
        description: "Congestion Surcharge", chargeCode: "CONGESTION_20", unit: "per_container", containerSize: "20",
        rateAmount: 100, sortOrder: 60, notes: "Manual option only when the yard has no available space.",
    },
    {
        rateType: "local", category: "container_yard_operation", billingScope: "display_only",
        description: "Congestion Surcharge", chargeCode: "CONGESTION_40", unit: "per_container", containerSize: "40",
        rateAmount: 200, sortOrder: 70, notes: "Manual option only when the yard has no available space.",
    },
    {
        rateType: "local", category: "stripping_stuffing", billingScope: "optional_stripping_stuffing",
        description: "Stripping / Stuffing (with Mano)", chargeCode: "STRIPPING_STUFFING_MANO_20", unit: "per_container", containerSize: "20",
        rateAmount: 4000, sortOrder: 80, notes: "Added only when explicitly selected for the booking.",
    },
    {
        rateType: "local", category: "stripping_stuffing", billingScope: "optional_stripping_stuffing",
        description: "Stripping / Stuffing (with Mano)", chargeCode: "STRIPPING_STUFFING_MANO_40", unit: "per_container", containerSize: "40",
        rateAmount: 8000, sortOrder: 90, notes: "Added only when explicitly selected for the booking.",
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
const inferRateRules = ({ description = "", unitLabel = "", requestedUnit = "", requestedContainerSize = "", currentRate = null } = {}) => {
    const descriptionText = String(description).trim().toLowerCase();
    const unitText = String(unitLabel).trim().toLowerCase();
    const combined = `${descriptionText} ${unitText}`;
    const sizeMatch = combined.match(/(?:^|\D)(20|40)(?:\D|$)/);
    const normalizedRequestedSize = ["20", "40", "all"].includes(String(requestedContainerSize || "").trim())
        ? String(requestedContainerSize || "").trim()
        : "";
    let containerSize = normalizedRequestedSize || sizeMatch?.[1] || currentRate?.containerSize || "all";
    const isLiftIn = /\blift\s*(in|on)\b/.test(descriptionText);
    const isLiftOut = /\blift\s*(out|off)\b/.test(descriptionText);
    const isLift = isLiftIn || isLiftOut;
    const isStorage = /\bstorage\b/.test(descriptionText) || /\/\s*day\b|\bper\s+day\b|\bdaily\b/.test(unitText);
    const isCongestion = /\bcongestion\b/.test(descriptionText);
    const isDocumentation = /\bdocumentation\b/.test(descriptionText);
    const isStrippingStuffing = /\bstripping\b|\bstuffing\b|\bmano\b/.test(descriptionText);
    const isTotalHandling = /\btotal\s+handling\b/.test(descriptionText);
    const isFixed = /\bfixed\b|\bflat\b/.test(unitText);
    let unit = normalizedUnitValues.has(requestedUnit) ? requestedUnit : currentRate?.unit || "per_container";
    if (isLift || isCongestion) {
        unit = "per_container";
    }
    else if (isStorage) {
        unit = "storage_day";
    }
    else if (isDocumentation && /transaction|fixed/.test(unitText)) {
        unit = /fixed/.test(unitText) ? "fixed" : "per_container";
        containerSize = "all";
    }
    else if (isFixed) {
        unit = "fixed";
    }
    else if (!normalizedUnitValues.has(requestedUnit)) {
        unit = "per_container";
    }
    let billingScope = currentRate?.billingScope || "base";
    if (isTotalHandling || isCongestion)
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
        sortOrder = containerSize === "40" ? 11 : 10;
    else if (isLiftOut)
        sortOrder = containerSize === "40" ? 21 : 20;
    else if (isTotalHandling)
        sortOrder = containerSize === "40" ? 31 : 30;
    else if (isStorage && containerSize === "20")
        sortOrder = 40;
    else if (isStorage && containerSize === "40")
        sortOrder = 50;
    else if (isCongestion && containerSize === "20")
        sortOrder = 60;
    else if (isCongestion && containerSize === "40")
        sortOrder = 70;
    else if (isStrippingStuffing && containerSize === "20")
        sortOrder = 80;
    else if (isStrippingStuffing && containerSize === "40")
        sortOrder = 90;
    const suggestedChargeCode = isLiftIn && ["20", "40"].includes(containerSize)
        ? `LIFT_ON_${containerSize}`
        : isLiftOut && ["20", "40"].includes(containerSize)
            ? `LIFT_OFF_${containerSize}`
            : isCongestion && ["20", "40"].includes(containerSize)
                ? `CONGESTION_${containerSize}`
                : isStorage && ["20", "40"].includes(containerSize)
                    ? `STORAGE_${containerSize}_DAY`
                    : isDocumentation
                        ? "DOCUMENTATION"
                        : "";
    return {
        category,
        billingScope,
        unit,
        containerSize,
        containerType: currentRate?.containerType || "all",
        loadStatus: currentRate?.loadStatus || "all",
        sortOrder,
        suggestedChargeCode,
        requiresContainerSize: isLift || isCongestion || isStorage || isTotalHandling,
    };
};
const buildRatePayload = (body = {}, currentRate = null) => {
    const description = String(body.description ?? currentRate?.description ?? "").trim();
    const requestedUnit = normalizedUnitValues.has(body.unit) ? body.unit : "";
    const unitLabel = String(body.unitLabel
        ?? currentRate?.unitLabel
        ?? getDefaultUnitLabel(requestedUnit || currentRate?.unit, currentRate?.containerSize)).trim();
    const rules = inferRateRules({ description, unitLabel, requestedUnit, requestedContainerSize: body.containerSize, currentRate });
    const { suggestedChargeCode, requiresContainerSize, ...normalizedRules } = rules;
    return normalizeRatePayload({
        description,
        chargeCode: suggestedChargeCode || currentRate?.chargeCode || body.chargeCode || toChargeCode(description, unitLabel),
        rateType: normalizeRateType(body.rateType ?? currentRate?.rateType),
        unitLabel,
        ...normalizedRules,
        containerType: body.containerType ?? currentRate?.containerType ?? normalizedRules.containerType ?? "all",
        loadStatus: normalizeLoadStatus(body.loadStatus ?? currentRate?.loadStatus ?? "all"),
        rateAmount: body.rateAmount ?? currentRate?.rateAmount ?? 0,
        freeDays: body.freeDays ?? currentRate?.freeDays ?? 0,
        minimumAmount: body.minimumAmount ?? currentRate?.minimumAmount ?? 0,
        effectiveDate: body.effectiveDate || new Date(),
        effectiveTo: null,
        status: "active",
        notes: body.notes ?? currentRate?.notes ?? "",
        version: currentRate ? Math.max(Number(currentRate.version) || 1, 1) + 1 : 1,
        supersedesRate: currentRate?._id || null,
    });
};
const safeRate = (rate) => {
    const doc = rate.toObject ? rate.toObject() : rate;
    return {
        id: String(doc._id),
        description: doc.description,
        chargeCode: doc.chargeCode,
        rateType: normalizeRateType(doc.rateType),
        category: doc.category || "container_yard_operation",
        billingScope: doc.billingScope || "base",
        unit: doc.unit,
        unitLabel: doc.unitLabel || getDefaultUnitLabel(doc.unit, doc.containerSize),
        containerSize: doc.containerSize,
        containerType: doc.containerType,
        loadStatus: normalizeLoadStatus(doc.loadStatus),
        chargeType: getChargeType(doc),
        rateAmount: Number(doc.rateAmount) || 0,
        freeDays: Number(doc.freeDays) || 0,
        minimumAmount: Number(doc.minimumAmount) || 0,
        effectiveDate: doc.effectiveDate,
        effectiveTo: doc.effectiveTo || null,
        version: Math.max(Number(doc.version) || 1, 1),
        supersedesRate: doc.supersedesRate ? String(doc.supersedesRate) : null,
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
    rateType: normalizeRateType(body.rateType),
    category: body.category || "container_yard_operation",
    billingScope: body.billingScope || "base",
    unit: body.unit || (body.billingScope === "storage" ? "storage_day" : "per_container"),
    unitLabel: String(body.unitLabel || getDefaultUnitLabel(body.unit || (body.billingScope === "storage" ? "storage_day" : "per_container"), String(body.containerSize || "all"))).trim(),
    containerSize: String(body.containerSize || "all"),
    containerType: body.containerType || "all",
    loadStatus: normalizeLoadStatus(body.loadStatus),
    rateAmount: toNumber(body.rateAmount, 0),
    freeDays: toNumber(body.freeDays, 0),
    minimumAmount: toNumber(body.minimumAmount, 0),
    effectiveDate: body.effectiveDate || new Date(),
    effectiveTo: body.effectiveTo || null,
    version: Math.max(toNumber(body.version, 1), 1),
    supersedesRate: body.supersedesRate || null,
    status: body.status || "active",
    notes: body.notes || "",
    sortOrder: toNumber(body.sortOrder, 100),
});
const getRateConfigKey = (rate = {}) => [
    normalizeRateType(rate.rateType),
    String(rate.chargeCode || rate.description || rate._id || ""),
    String(rate.containerSize || "all"),
    String(rate.containerType || "all"),
    normalizeLoadStatus(rate.loadStatus),
].join(":");
const addEffectiveWindowFilter = (query, asOf = new Date()) => {
    query.effectiveDate = { $lte: asOf };
    query.$and = [
        ...(query.$and || []),
        { $or: [{ effectiveTo: null }, { effectiveTo: { $gt: asOf } }, { effectiveTo: { $exists: false } }] },
    ];
    return query;
};
const validateConfiguredRate = (payload) => {
    const description = String(payload.description || "").toLowerCase();
    const needsSize = /lift|storage|congestion|total\s+handling/.test(description);
    if (needsSize && !["20", "40"].includes(String(payload.containerSize))) {
        return "Select a 20ft or 40ft unit for this billing rate.";
    }
    if (!["all", "empty", "laden"].includes(normalizeLoadStatus(payload.loadStatus))) {
        return "Container load status must be All, Empty, or Loaded.";
    }
    if (/congestion/.test(description) && payload.billingScope !== "display_only") {
        return "Congestion Surcharge must remain a manual option and cannot be an automatic base charge.";
    }
    return "";
};
const findCurrentMatchingRate = async (payload, excludeId = null) => {
    // The open-ended version may be effective now or scheduled for the future.
    // Treat either as the current configuration head so duplicate future
    // versions cannot be scheduled accidentally.
    const query = {
        rateType: payload.rateType,
        chargeCode: payload.chargeCode,
        containerSize: payload.containerSize,
        containerType: payload.containerType,
        loadStatus: payload.loadStatus,
        status: "active",
        $or: [{ effectiveTo: null }, { effectiveTo: { $exists: false } }],
    };
    if (excludeId)
        query._id = { $ne: excludeId };
    return BillingRate_js_1.default.findOne(query).sort({ effectiveDate: -1, createdAt: -1 });
};
const closeRateVersion = async (rate, effectiveTo, { markInactive = null } = {}) => {
    const closeAt = new Date(effectiveTo);
    rate.effectiveTo = closeAt;
    const shouldMarkInactive = markInactive === null ? closeAt.getTime() <= Date.now() : Boolean(markInactive);
    if (shouldMarkInactive)
        rate.status = "inactive";
    else
        rate.status = "active";
    await rate.save();
    return rate;
};
const listBillingRates = async (req, res) => {
    const { status, search, category, rateType, loadStatus } = req.query;
    const now = new Date();
    const baseQuery = {};
    if (status && status !== "all")
        baseQuery.status = status;
    else
        baseQuery.status = "active";
    if (category && category !== "all")
        baseQuery.category = category;
    if (rateType && rateType !== "all")
        baseQuery.rateType = normalizeRateType(rateType);
    if (loadStatus && loadStatus !== "all")
        baseQuery.loadStatus = normalizeLoadStatus(loadStatus);
    if (search) {
        const term = String(search).trim();
        baseQuery.$or = [
            { description: { $regex: term, $options: "i" } },
            { chargeCode: { $regex: term, $options: "i" } },
            { unitLabel: { $regex: term, $options: "i" } },
            { notes: { $regex: term, $options: "i" } },
        ];
    }
    baseQuery.billingScope = { $ne: "optional_stripping_stuffing" };

    const currentQuery = { ...baseQuery };
    addEffectiveWindowFilter(currentQuery, now);
    const scheduledQuery = {
        ...baseQuery,
        status: "active",
        effectiveDate: { $gt: now },
        $and: [
            ...(baseQuery.$and || []),
            { $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }, { effectiveTo: { $exists: false } }] },
        ],
    };

    const [rates, scheduledRates] = await Promise.all([
        BillingRate_js_1.default.find(currentQuery)
            .sort({ rateType: 1, category: 1, sortOrder: 1, effectiveDate: -1, createdAt: -1 })
            .limit(500)
            .lean(),
        BillingRate_js_1.default.find(scheduledQuery)
            .sort({ effectiveDate: 1, rateType: 1, category: 1, sortOrder: 1, createdAt: 1 })
            .limit(500)
            .lean(),
    ]);
    const latestByConfig = new Map();
    for (const rate of rates) {
        const key = getRateConfigKey(rate);
        if (!latestByConfig.has(key))
            latestByConfig.set(key, rate);
    }
    return res.json({
        success: true,
        rates: Array.from(latestByConfig.values()).filter((rate) => !isDocumentationRate(rate)).map(safeRate),
        scheduledRates: scheduledRates.filter((rate) => !isDocumentationRate(rate)).map(safeRate),
        referenceRates: exports.OTLI_REFERENCE_RATES.filter((rate) => rate.billingScope !== "optional_stripping_stuffing" && !isDocumentationRate(rate)),
    });
};
exports.listBillingRates = listBillingRates;
const createBillingRate = async (req, res) => {
    if (!req.body?.effectiveDate) {
        return res.status(400).json({ success: false, message: "Effectivity date is required for every new billing rate." });
    }
    const requestedEffectiveDate = new Date(req.body.effectiveDate);
    if (Number.isNaN(requestedEffectiveDate.getTime())) {
        return res.status(400).json({ success: false, message: "Select a valid effectivity date for the new rate." });
    }
    const payload = buildRatePayload(req.body);
    if (!payload.description || !payload.unitLabel) {
        return res.status(400).json({ success: false, message: "Description and Unit are required." });
    }
    if (isDocumentationRate(payload)) {
        return res.status(400).json({ success: false, message: "Documentation Fee has been removed and cannot be configured." });
    }
    if (payload.rateAmount <= 0) {
        return res.status(400).json({ success: false, message: "Rate amount must be greater than zero." });
    }
    const validationError = validateConfiguredRate(payload);
    if (validationError)
        return res.status(400).json({ success: false, message: validationError });
    const existing = await findCurrentMatchingRate(payload);
    if (existing) {
        return res.status(409).json({ success: false, message: "A current rate already exists for the same charge, container size/type, and load status. Edit that rate to create a new version." });
    }
    const rate = await BillingRate_js_1.default.create(payload);
    const safe = safeRate(rate);
    (0, socket_js_1.emitToAdmins)("billing_rate:created", safe);
    return res.status(201).json({ success: true, message: "Billing rate created successfully.", rate: safe });
};
exports.createBillingRate = createBillingRate;
const updateBillingRate = async (req, res) => {
    if (!req.body?.effectiveDate) {
        return res.status(400).json({ success: false, message: "Effectivity date is required when applying a new rate version." });
    }
    const currentRate = await BillingRate_js_1.default.findById(req.params.id);
    if (!currentRate)
        return res.status(404).json({ success: false, message: "Billing rate not found." });
    const now = new Date();
    if (currentRate.effectiveTo && new Date(currentRate.effectiveTo).getTime() <= now.getTime()) {
        return res.status(409).json({ success: false, message: "This is a historical rate version and cannot be edited. Edit the current rate instead." });
    }
    if (currentRate.effectiveTo && new Date(currentRate.effectiveTo).getTime() > now.getTime()) {
        return res.status(409).json({ success: false, message: "This rate already has a scheduled replacement. Cancel the scheduled rate first if you need to change the effectivity date or amount." });
    }
    const payload = buildRatePayload(req.body, currentRate);
    if (!payload.description || !payload.unitLabel) {
        return res.status(400).json({ success: false, message: "Description and Unit are required." });
    }
    if (isDocumentationRate(payload)) {
        return res.status(400).json({ success: false, message: "Documentation Fee has been removed and cannot be configured." });
    }
    if (payload.rateAmount <= 0) {
        return res.status(400).json({ success: false, message: "Rate amount must be greater than zero." });
    }
    const validationError = validateConfiguredRate(payload);
    if (validationError)
        return res.status(400).json({ success: false, message: validationError });
    const currentStart = new Date(currentRate.effectiveDate || currentRate.createdAt || 0).getTime();
    const nextEffectiveAt = new Date(payload.effectiveDate || Date.now());
    if (Number.isNaN(nextEffectiveAt.getTime())) {
        return res.status(400).json({ success: false, message: "Select a valid effectivity date for the new rate." });
    }
    if (nextEffectiveAt.getTime() <= currentStart) {
        return res.status(400).json({ success: false, message: "The new effectivity date must be later than the current rate's effective date." });
    }
    payload.effectiveDate = nextEffectiveAt;
    payload.effectiveTo = null;
    payload.status = "active";
    payload.version = Math.max(Number(currentRate.version) || 1, 1) + 1;
    payload.supersedesRate = currentRate._id;
    const conflicting = await findCurrentMatchingRate(payload, currentRate._id);
    if (conflicting) {
        return res.status(409).json({ success: false, message: "Another current or scheduled rate already exists for the same charge and Empty/Loaded classification." });
    }
    const newRate = await BillingRate_js_1.default.create(payload);
    try {
        await closeRateVersion(currentRate, nextEffectiveAt);
    }
    catch (error) {
        await BillingRate_js_1.default.deleteOne({ _id: newRate._id }).catch(() => undefined);
        throw error;
    }
    const safe = safeRate(newRate);
    const isScheduled = nextEffectiveAt.getTime() > now.getTime();
    (0, socket_js_1.emitToAdmins)("billing_rate:updated", { ...safe, previousRateId: String(currentRate._id), versioned: true, scheduled: isScheduled });
    return res.json({
        success: true,
        message: isScheduled
            ? "New billing rate version scheduled successfully. The existing rate remains applicable until the effectivity date."
            : "Billing rate updated as a new effective version. Historical rate periods were preserved.",
        rate: safe,
        previousRateId: String(currentRate._id),
        scheduled: isScheduled,
    });
};
exports.updateBillingRate = updateBillingRate;
const seedReferenceBillingRates = async (req, res) => {
    const requestedDate = req.body?.effectiveDate ? new Date(req.body.effectiveDate) : new Date();
    const effectiveDate = Number.isNaN(requestedDate.getTime()) ? new Date() : requestedDate;
    const mode = req.body?.mode || "upsert";
    const createdOrUpdated = [];
    for (const template of exports.OTLI_REFERENCE_RATES.filter((rate) => rate.billingScope !== "optional_stripping_stuffing")) {
        const payload = normalizeRatePayload({
            ...template,
            effectiveDate,
            effectiveTo: null,
            status: "active",
            containerType: "all",
            loadStatus: normalizeLoadStatus(template.loadStatus || "all"),
            freeDays: 0,
            minimumAmount: 0,
        });
        const currentQuery = {
            rateType: payload.rateType,
            chargeCode: payload.chargeCode,
            containerSize: payload.containerSize,
            containerType: payload.containerType,
            loadStatus: payload.loadStatus,
            status: "active",
        };
        addEffectiveWindowFilter(currentQuery, new Date());
        const currentRate = await BillingRate_js_1.default.findOne(currentQuery).sort({ effectiveDate: -1, createdAt: -1 });
        if (currentRate && mode === "skip_existing") {
            createdOrUpdated.push(currentRate);
            continue;
        }
        if (currentRate) {
            const nextEffectiveAt = effectiveDate.getTime() > new Date(currentRate.effectiveDate).getTime()
                ? effectiveDate
                : new Date(Math.max(Date.now(), new Date(currentRate.effectiveDate).getTime() + 1));
            const versionPayload = {
                ...payload,
                effectiveDate: nextEffectiveAt,
                version: Math.max(Number(currentRate.version) || 1, 1) + 1,
                supersedesRate: currentRate._id,
            };
            const nextRate = await BillingRate_js_1.default.create(versionPayload);
            await closeRateVersion(currentRate, nextEffectiveAt);
            createdOrUpdated.push(nextRate);
        }
        else {
            createdOrUpdated.push(await BillingRate_js_1.default.create(payload));
        }
    }
    const ids = createdOrUpdated.map((rate) => rate._id);
    const rates = await BillingRate_js_1.default.find({ _id: { $in: ids } }).sort({ rateType: 1, category: 1, sortOrder: 1 });
    (0, socket_js_1.emitToAdmins)("billing_rate:reference_applied", { count: rates.length, effectiveDate });
    return res.json({
        success: true,
        message: "OTLI reference rates have been applied to Rate Setup without overwriting historical rate versions.",
        rates: rates.map(safeRate),
    });
};
exports.seedReferenceBillingRates = seedReferenceBillingRates;
const deleteBillingRate = async (req, res) => {
    const rate = await BillingRate_js_1.default.findById(req.params.id);
    if (!rate)
        return res.status(404).json({ success: false, message: "Billing rate not found." });
    const safe = safeRate(rate);
    const now = new Date();
    const startsAt = new Date(rate.effectiveDate);
    const isScheduled = startsAt.getTime() > now.getTime();
    if (isScheduled) {
        const supersededRateId = rate.supersedesRate;
        await rate.deleteOne();
        if (supersededRateId) {
            const previousRate = await BillingRate_js_1.default.findById(supersededRateId);
            if (previousRate && previousRate.effectiveTo && new Date(previousRate.effectiveTo).getTime() === startsAt.getTime()) {
                previousRate.effectiveTo = null;
                previousRate.status = "active";
                await previousRate.save();
            }
        }
        (0, socket_js_1.emitToAdmins)("billing_rate:deleted", { ...safe, scheduled: true });
        return res.json({ success: true, message: "Scheduled rate change cancelled. The current rate will continue without interruption." });
    }
    if (!rate.effectiveTo || new Date(rate.effectiveTo).getTime() > now.getTime()) {
        rate.effectiveTo = now;
        rate.status = "inactive";
        await rate.save();
    }
    (0, socket_js_1.emitToAdmins)("billing_rate:deleted", safe);
    return res.json({ success: true, message: "Billing rate deactivated. Historical transactions and past rate periods were preserved." });
};
exports.deleteBillingRate = deleteBillingRate;
const getManilaDayRange = (value = new Date()) => {
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - (8 * 60 * 60 * 1000));
    const end = new Date(start.getTime() + (24 * 60 * 60 * 1000));
    return { start, end, dateKey: `${parts.year}-${parts.month}-${parts.day}` };
};
const getClientRateChangeNotice = async (req, res) => {
    const now = new Date();
    const { start, end, dateKey } = getManilaDayRange(now);
    const rateType = normalizeRateType(req.user?.companyMarket);
    const changedRates = await BillingRate_js_1.default.find({
        rateType,
        effectiveDate: { $gte: start, $lt: end },
        billingScope: { $ne: "optional_stripping_stuffing" },
        status: { $in: ["active", "inactive"] },
    })
        .sort({ sortOrder: 1, chargeCode: 1, containerSize: 1, loadStatus: 1, createdAt: 1 })
        .populate("supersedesRate")
        .lean();
    const visibleChanges = changedRates.filter((rate) => !isDocumentationRate(rate));
    if (!visibleChanges.length) {
        return res.json({ success: true, notice: null, changes: [] });
    }
    const rateIds = visibleChanges.map((rate) => String(rate._id)).sort();
    // One popup per client, market, and effectivity day. If several rates
    // share the same date they are consolidated into this single notice.
    const noticeKey = `rate-change:${rateType}:${dateKey}`;
    let notification = await Notification_js_1.default.findOne({
        recipient: req.user._id,
        type: "rate_change",
        "metadata.noticeKey": noticeKey,
    });
    if (notification?.readAt) {
        return res.json({ success: true, notice: null, acknowledged: true, changes: [] });
    }
    const changes = visibleChanges.map((rate) => {
        const previousRate = rate.supersedesRate && typeof rate.supersedesRate === "object" ? rate.supersedesRate : null;
        return {
            id: String(rate._id),
            chargeType: getChargeType(rate),
            description: rate.description || "Billing Rate",
            chargeCode: rate.chargeCode || "",
            containerSize: rate.containerSize || "all",
            loadStatus: normalizeLoadStatus(rate.loadStatus),
            previousRateAmount: previousRate ? Number(previousRate.rateAmount) || 0 : null,
            rateAmount: Number(rate.rateAmount) || 0,
            effectiveDate: rate.effectiveDate,
            version: Math.max(Number(rate.version) || 1, 1),
        };
    });
    if (!notification) {
        try {
            notification = await Notification_js_1.default.create({
                recipient: req.user._id,
                type: "rate_change",
                title: "New rates effective today",
                message: `Updated ${rateType === "international" ? "International" : "Local"} rates are effective ${dateKey}. Ongoing transactions will use the previous rate before the effectivity date and the new rate from the effectivity date onward.`,
                actionPath: "/rates",
                metadata: {
                    noticeKey,
                    rateType,
                    effectiveDate: dateKey,
                    rateIds,
                },
            });
            const payload = (0, notificationService_js_1.safeNotification)(notification);
            (0, socket_js_1.emitToUser)(req.user._id, "notification:created", payload);
        }
        catch (error) {
            if (error?.code === 11000) {
                notification = await Notification_js_1.default.findOne({
                    recipient: req.user._id,
                    type: "rate_change",
                    "metadata.noticeKey": noticeKey,
                });
            }
            else {
                throw error;
            }
        }
    }
    if (notification?.readAt) {
        return res.json({ success: true, notice: null, acknowledged: true, changes: [] });
    }
    return res.json({
        success: true,
        notice: (0, notificationService_js_1.safeNotification)(notification),
        effectiveDate: dateKey,
        rateType,
        changes,
    });
};
exports.getClientRateChangeNotice = getClientRateChangeNotice;
const listActiveBillingRates = async (req, res) => {
    const now = new Date();
    const query = {
        status: "active",
        billingScope: { $ne: "optional_stripping_stuffing" },
    };
    if (req.query.rateType && req.query.rateType !== "all") {
        query.rateType = normalizeRateType(req.query.rateType);
    }
    if (req.query.loadStatus && req.query.loadStatus !== "all") {
        query.loadStatus = normalizeLoadStatus(req.query.loadStatus);
    }
    addEffectiveWindowFilter(query, now);
    const rates = await BillingRate_js_1.default.find(query)
        .sort({ category: 1, sortOrder: 1, effectiveDate: -1, createdAt: -1 })
        .lean();
    const latestByConfig = new Map();
    for (const rate of rates) {
        const key = getRateConfigKey(rate);
        if (!latestByConfig.has(key))
            latestByConfig.set(key, rate);
    }
    return res.json({ success: true, rates: Array.from(latestByConfig.values()).filter((rate) => !isDocumentationRate(rate)).map(safeRate) });
};
exports.listActiveBillingRates = listActiveBillingRates;
