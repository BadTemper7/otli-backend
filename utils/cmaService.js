"use strict";

const CMAClientModule = require("../models/CMAClient.js");
const CMARateModule = require("../models/CMARate.js");
const CMABillingModule = require("../models/CMABilling.js");
const UserModule = require("../models/User.js");
const { getCalendarDayNumber } = require("./billingDays.js");

const CMAClient = CMAClientModule.default || CMAClientModule;
const CMARate = CMARateModule.default || CMARateModule;
const CMABilling = CMABillingModule.default || CMABillingModule;
const User = UserModule.default || UserModule;

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const objectId = (value) => String(value?._id || value || "");
const parseDate = (value) => {
    if (!value) return null;
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};
const normalizeShippingLine = (value = "") => String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
const normalizeCode = (value = "") => String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

const configuredDocsFeeCodes = new Set(
    String(process.env.CMA_DOCS_FEE_CODES || "DOCS_FEE,DOC_FEE,DOCUMENTATION_FEE,DOCUMENT_FEE")
        .split(",")
        .map(normalizeCode)
        .filter(Boolean)
);
const isDocumentationFeeRate = (rate = {}) => {
    const code = normalizeCode(rate.chargeCode || "");
    const description = normalizeCode(rate.description || "");
    if (configuredDocsFeeCodes.has(code)) return true;
    return /(^|_)(DOC|DOCS|DOCUMENT|DOCUMENTATION)(_|$)/.test(code) ||
        /(^|_)(DOC|DOCS|DOCUMENT|DOCUMENTATION)(_|$)/.test(description);
};

const resolveCMAClientForBooking = async ({ clientId, shippingLine, manualCmaClientId = null } = {}) => {
    if (manualCmaClientId) {
        const cmaClient = await CMAClient.findOne({ _id: manualCmaClientId, status: "active" });
        if (!cmaClient) {
            const error = new Error("Selected CMA client is not available or inactive.");
            error.statusCode = 400;
            throw error;
        }
        return { isCMA: true, cmaClient, source: "manual" };
    }
    if (clientId) {
        const trucker = await User.findById(clientId).select("isCMATruckerClient cmaClient");
        if (trucker?.isCMATruckerClient && trucker.cmaClient) {
            const cmaClient = await CMAClient.findOne({ _id: trucker.cmaClient, status: "active" });
            if (cmaClient) return { isCMA: true, cmaClient, source: "client_relationship" };
        }
    }
    const normalizedLine = normalizeShippingLine(shippingLine);
    if (normalizedLine) {
        const cmaClient = await CMAClient.findOne({ status: "active", shippingLines: normalizedLine });
        if (cmaClient) return { isCMA: true, cmaClient, source: "shipping_line" };
    }
    return { isCMA: false, cmaClient: null, source: "none" };
};

const applyCMAIdentity = (booking, match, identifiedBy = null) => {
    const isCMA = Boolean(match?.isCMA && match?.cmaClient);
    booking.isCMASpecialClient = isCMA;
    booking.cmaClient = isCMA ? (match.cmaClient._id || match.cmaClient) : null;
    booking.cmaIdentificationSource = isCMA ? (match.source || "manual") : "none";
    booking.cmaIdentifiedAt = isCMA ? new Date() : null;
    booking.cmaIdentifiedBy = isCMA && identifiedBy ? (identifiedBy._id || identifiedBy) : null;
    if (isCMA) booking.loloPaymentStage = "gate_out";
    return booking;
};

const rateMatchesBooking = (rate, booking) => {
    if (String(rate.rateType || "local") !== String(booking.rateType || "local")) return false;
    if (String(rate.containerSize || "all") !== "all" && String(rate.containerSize) !== String(booking.containerSize)) return false;
    if (String(rate.containerType || "all") !== "all" && String(rate.containerType) !== String(booking.containerType)) return false;
    const load = String(booking.containerLoadStatus || "empty").toLowerCase();
    if (String(rate.loadStatus || "all") !== "all" && String(rate.loadStatus) !== load) return false;
    return true;
};
const isEffective = (rate, at) => {
    const date = parseDate(at) || new Date();
    const from = parseDate(rate.effectiveDate);
    const to = parseDate(rate.effectiveTo);
    if (from && date.getTime() < from.getTime()) return false;
    if (to && date.getTime() >= to.getTime()) return false;
    return true;
};
const specificityScore = (rate, booking, cmaId) => {
    let score = objectId(rate.cmaClient) === cmaId ? 10000 : 0;
    if (String(rate.containerSize || "all") === String(booking.containerSize)) score += 100;
    if (String(rate.containerType || "all") === String(booking.containerType)) score += 10;
    if (String(rate.loadStatus || "all") === String(booking.containerLoadStatus || "empty")) score += 1;
    return score;
};
const selectRatesForDate = (rates, booking, cmaId, at) => {
    const candidates = rates.filter((rate) => rateMatchesBooking(rate, booking) && isEffective(rate, at));
    const groups = new Map();
    for (const rate of candidates) {
        const key = normalizeCode(rate.chargeCode || rate.description || rate._id);
        const current = groups.get(key);
        if (!current) {
            groups.set(key, rate);
            continue;
        }
        const currentScore = specificityScore(current, booking, cmaId);
        const nextScore = specificityScore(rate, booking, cmaId);
        const currentDate = parseDate(current.effectiveDate)?.getTime() || 0;
        const nextDate = parseDate(rate.effectiveDate)?.getTime() || 0;
        if (nextScore > currentScore || (nextScore === currentScore && nextDate > currentDate)) groups.set(key, rate);
    }
    return [...groups.values()].sort((a, b) => (Number(a.sortOrder) || 100) - (Number(b.sortOrder) || 100));
};
const quantityForRate = (rate, booking) => rate.unit === "per_teu" ? (Number(booking.containerSize) === 40 ? 2 : 1) : 1;
const makeLineItem = (rate, booking, { quantity = 1, serviceDate = null, billingPeriodStart = null, billingPeriodEnd = null, description = "" } = {}) => {
    const rateAmount = Math.max(Number(rate.rateAmount) || 0, 0);
    const minimumAmount = Math.max(Number(rate.minimumAmount) || 0, 0);
    const amount = Math.max(roundMoney(rateAmount * quantity), minimumAmount);
    return {
        rate: rate._id,
        chargeCode: rate.chargeCode || "",
        description: description || rate.description || rate.chargeCode || "CMA Charge",
        chargeType: rate.chargeType || "other",
        unit: rate.unit || "per_container",
        quantity,
        rateAmount,
        freeDays: Math.max(Number(rate.freeDays) || 0, 0),
        minimumAmount,
        rateType: booking.rateType === "international" ? "international" : "local",
        containerSize: rate.containerSize || "all",
        containerType: rate.containerType || "all",
        loadStatus: rate.loadStatus || "all",
        effectiveDate: rate.effectiveDate || null,
        serviceDate,
        billingPeriodStart,
        billingPeriodEnd,
        amount,
    };
};
const dayToDate = (day) => new Date(day * 24 * 60 * 60 * 1000 + (12 * 60 * 60 * 1000));

const computeCMABillingForBooking = async (booking, { asOf = new Date(), stage = "gate_out", persist = true, updatedBy = null } = {}) => {
    if (!booking?.isCMASpecialClient || !booking?.cmaClient || !booking?.client) {
        return { isCMA: false, hasMatchedRates: false, lineItems: [], subtotal: 0, vatAmount: 0, total: 0, billing: null };
    }
    const cmaId = objectId(booking.cmaClient);
    const clientId = objectId(booking.client);
    const effectiveThrough = parseDate(asOf) || new Date();
    const rates = await CMARate.find({
        $or: [{ cmaClient: booking.cmaClient }, { cmaClient: null }],
        rateType: booking.rateType === "international" ? "international" : "local",
        status: { $in: ["active", "inactive"] },
        effectiveDate: { $lte: effectiveThrough },
    }).sort({ sortOrder: 1, chargeCode: 1, effectiveDate: -1, createdAt: -1 });

    const lineItems = [];
    const matchedRateIds = new Set();
    const eventDate = parseDate(booking.submittedAt || booking.createdAt || booking.inDate) || effectiveThrough;
    const gateInDate = parseDate(booking.gateInApprovedAt || booking.storedAt || booking.inDate || booking.storageStartDate) || effectiveThrough;
    const gateOutDate = parseDate(booking.outDate || booking.releasedAt || effectiveThrough) || effectiveThrough;

    const eventTypes = stage === "gate_in" ? new Set(["lolo"]) : new Set(["lolo", "other"]);
    for (const chargeType of eventTypes) {
        const serviceDate = chargeType === "lolo" ? eventDate : gateOutDate;
        const selected = selectRatesForDate(rates.filter((rate) => rate.chargeType === chargeType && !["per_day", "storage_day"].includes(rate.unit)), booking, cmaId, serviceDate);
        for (const rate of selected) {
            matchedRateIds.add(String(rate._id));
            lineItems.push(makeLineItem(rate, booking, { quantity: quantityForRate(rate, booking), serviceDate }));
        }
    }

    if (stage === "gate_out") {
        const startDay = getCalendarDayNumber(gateInDate);
        const endDay = getCalendarDayNumber(gateOutDate);
        const storageRates = rates.filter((rate) => rate.chargeType === "storage" || ["per_day", "storage_day"].includes(rate.unit));
        if (startDay !== null && endDay !== null && endDay >= startDay && storageRates.length) {
            const groups = new Map();
            for (let day = startDay; day <= endDay; day += 1) {
                const serviceDate = dayToDate(day);
                const selected = selectRatesForDate(storageRates, booking, cmaId, serviceDate);
                const transactionDay = (day - startDay) + 1;
                for (const rate of selected) {
                    matchedRateIds.add(String(rate._id));
                    if (transactionDay <= Math.max(Number(rate.freeDays) || 0, 0)) continue;
                    const key = String(rate._id);
                    const current = groups.get(key);
                    if (current) {
                        current.quantity += 1;
                        current.endDay = day;
                    } else {
                        groups.set(key, { rate, quantity: 1, startDay: day, endDay: day });
                    }
                }
            }
            for (const group of groups.values()) {
                lineItems.push(makeLineItem(group.rate, booking, {
                    quantity: group.quantity,
                    billingPeriodStart: dayToDate(group.startDay),
                    billingPeriodEnd: dayToDate(group.endDay),
                }));
            }
        }

        // Other CMA charges must come from CMA Rates. Normal client additional
        // charges are intentionally excluded so CMA billing stays independent.
    }

    const subtotal = roundMoney(lineItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0));
    const configuredVatRate = Number(process.env.VAT_RATE ?? 0.12);
    const isVatApplicable = booking.isVatApplicable !== false;
    const vatRate = isVatApplicable && Number.isFinite(configuredVatRate) && configuredVatRate >= 0 ? configuredVatRate : 0;
    const vatAmount = roundMoney(subtotal * vatRate);
    const total = roundMoney(subtotal + vatAmount);

    let billing = await CMABilling.findOne({ booking: booking._id });
    if (persist) {
        if (!billing) {
            billing = new CMABilling({
                billingReference: `CMA-${booking.bookingReference || booking._id}`,
                booking: booking._id,
                cmaClient: booking.cmaClient,
                truckerClient: booking.client,
                createdBy: updatedBy || null,
            });
        }
        billing.cmaClient = booking.cmaClient;
        billing.truckerClient = booking.client;
        billing.bookingReference = booking.bookingReference || "";
        billing.bookingNumber = booking.bookingNumber || "";
        billing.containerNumber = booking.containerNumber || "";
        billing.containerSize = Number(booking.containerSize) || 20;
        billing.containerType = booking.containerType || "";
        billing.containerLoadStatus = booking.containerLoadStatus || "empty";
        billing.rateType = booking.rateType === "international" ? "international" : "local";
        billing.shippingLine = booking.shippingLine || "";
        billing.gateInAt = parseDate(booking.gateInApprovedAt || booking.storedAt || booking.inDate);
        billing.gateOutAt = parseDate(booking.outDate || booking.releasedAt);
        billing.lineItems = lineItems;
        billing.subtotal = subtotal;
        billing.isVatApplicable = isVatApplicable;
        billing.vatRate = vatRate;
        billing.vatAmount = vatAmount;
        billing.totalAmount = total;
        billing.billingStage = stage === "gate_in" ? "gate_in" : "gate_out";
        billing.computedAt = effectiveThrough;
        billing.updatedBy = updatedBy || billing.updatedBy || null;
        await billing.save();
    }
    return { isCMA: true, hasMatchedRates: matchedRateIds.size > 0, matchedRateCount: matchedRateIds.size, lineItems, subtotal, vatRate, vatAmount, total, billing };
};

const ensureCMABillingRecorded = async (booking, { updatedBy = null } = {}) => {
    if (!booking?.isCMASpecialClient) return null;
    const result = await computeCMABillingForBooking(booking, {
        asOf: booking.outDate || booking.releasedAt || new Date(),
        stage: "gate_out",
        persist: true,
        updatedBy,
    });
    if (!result.hasMatchedRates || !result.billing || !result.lineItems.length) {
        const error = new Error("CMA Billing must contain applicable CMA LOLO / Storage rates before this container can be released.");
        error.statusCode = 400;
        throw error;
    }
    return result.billing;
};

module.exports = {
    normalizeShippingLine,
    isDocumentationFeeRate,
    resolveCMAClientForBooking,
    applyCMAIdentity,
    computeCMABillingForBooking,
    ensureCMABillingRecorded,
};
