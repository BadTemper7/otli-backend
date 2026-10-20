"use strict";

// The storage view spans two independent collections. Keep them in a stable,
// source-grouped order (bookings newest first, then legacy newest first).
// This lets MongoDB use bounded, indexed find/skip/limit queries instead of
// a cross-collection $unionWith + blocking global sort for every page.
const safeInt = (value, fallback) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
};

const planStoragePage = ({ requestedPage = 1, limit = 25, bookingTotal = 0, legacyTotal = 0 }) => {
    const pageSize = Math.min(safeInt(limit, 25), 100);
    const bookings = Math.max(0, Math.floor(Number(bookingTotal) || 0));
    const legacy = Math.max(0, Math.floor(Number(legacyTotal) || 0));
    const total = bookings + legacy;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(safeInt(requestedPage, 1), totalPages);
    const offset = (page - 1) * pageSize;
    const bookingSkip = Math.min(offset, bookings);
    const bookingLimit = Math.min(pageSize, Math.max(0, bookings - bookingSkip));
    const legacySkip = Math.min(Math.max(0, offset - bookings), legacy);
    const legacyLimit = Math.min(pageSize - bookingLimit, Math.max(0, legacy - legacySkip));
    return {
        page,
        limit: pageSize,
        total,
        totalPages,
        booking: { skip: bookingSkip, limit: bookingLimit },
        legacy: { skip: legacySkip, limit: legacyLimit },
    };
};

module.exports = { planStoragePage };
