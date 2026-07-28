"use strict";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_BILLING_TIME_ZONE = process.env.BILLING_TIME_ZONE || "Asia/Manila";

const formatterCache = new Map();

const getDateFormatter = (timeZone) => {
    if (!formatterCache.has(timeZone)) {
        formatterCache.set(timeZone, new Intl.DateTimeFormat("en-CA", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }));
    }
    return formatterCache.get(timeZone);
};

const parseDate = (value) => {
    if (!value)
        return null;
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const getCalendarDayNumber = (value, timeZone = DEFAULT_BILLING_TIME_ZONE) => {
    const date = parseDate(value);
    if (!date)
        return null;

    const parts = getDateFormatter(timeZone).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const year = Number(values.year);
    const month = Number(values.month);
    const day = Number(values.day);

    if (![year, month, day].every(Number.isFinite))
        return null;

    return Math.floor(Date.UTC(year, month - 1, day) / MILLISECONDS_PER_DAY);
};

const getCalendarBillingDays = (startValue, endValue, { minimumDays = 1, timeZone = DEFAULT_BILLING_TIME_ZONE } = {}) => {
    const startDay = getCalendarDayNumber(startValue, timeZone);
    const endDay = getCalendarDayNumber(endValue, timeZone);

    if (startDay === null || endDay === null || endDay < startDay)
        return 0;

    const inclusiveCalendarDays = (endDay - startDay) + 1;
    return Math.max(inclusiveCalendarDays, Math.max(Number(minimumDays) || 0, 0));
};

module.exports = {
    DEFAULT_BILLING_TIME_ZONE,
    getCalendarBillingDays,
    getCalendarDayNumber,
};
