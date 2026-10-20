"use strict";

// Storage Monitoring counts containers actually in storage, not bookings that
// only reserve yard space. Keep these in sync with the storage inventory view.
const STORED_BOOKING_STATUSES = [
    "stored_in_assigned_area",
    "gate_out_requested",
    "gate_out_approved",
    "gate_out_reversal_requested",
];
const STORED_LEGACY_STATUSES = [
    "in_yard",
    "for_billing",
    "pending_payment",
    "payment_verified",
    "cleared_for_gate_out",
    "hold",
];

const buildStorageOccupancyPipeline = ({ areaField, blockField, statuses }) => [
    { $match: { status: { $in: statuses } } },
    {
        $group: {
            _id: { area: `$${areaField}`, block: `$${blockField}` },
            containerCount: { $sum: 1 },
            usedTeu: {
                $sum: { $cond: [{ $in: ["$containerSize", [40, "40"]] }, 2, 1] },
            },
        },
    },
];

const asId = (value) => value == null ? "" : String(value);
const roundCapacity = (value) => Math.round((Number(value) || 0) * 100) / 100;

const summarizeStorageOccupancy = (rows) => {
    const areas = new Map();
    const blocks = new Map();
    const totals = {
        totalContainers: 0,
        totalTeu: 0,
        assignedContainers: 0,
        assignedTeu: 0,
        unassignedContainers: 0,
        unassignedTeu: 0,
    };

    for (const row of rows) {
        const areaId = asId(row?._id?.area);
        const blockId = asId(row?._id?.block);
        const containerCount = Number(row?.containerCount) || 0;
        const usedTeu = Number(row?.usedTeu) || 0;
        totals.totalContainers += containerCount;
        totals.totalTeu += usedTeu;

        if (!areaId) {
            totals.unassignedContainers += containerCount;
            totals.unassignedTeu += usedTeu;
            continue;
        }

        totals.assignedContainers += containerCount;
        totals.assignedTeu += usedTeu;
        if (!areas.has(areaId)) {
            areas.set(areaId, { areaId, containerCount: 0, usedTeu: 0 });
        }
        const area = areas.get(areaId);
        area.containerCount += containerCount;
        area.usedTeu += usedTeu;

        if (blockId) {
            const key = `${areaId}:${blockId}`;
            if (!blocks.has(key)) {
                blocks.set(key, { areaId, blockId, containerCount: 0, usedTeu: 0 });
            }
            const block = blocks.get(key);
            block.containerCount += containerCount;
            block.usedTeu += usedTeu;
        }
    }

    return {
        ...totals,
        totalTeu: roundCapacity(totals.totalTeu),
        assignedTeu: roundCapacity(totals.assignedTeu),
        unassignedTeu: roundCapacity(totals.unassignedTeu),
        areas: [...areas.values()].map((row) => ({ ...row, usedTeu: roundCapacity(row.usedTeu) })),
        blocks: [...blocks.values()].map((row) => ({ ...row, usedTeu: roundCapacity(row.usedTeu) })),
    };
};

const loadStorageOccupancy = async () => {
    const Booking = require("../models/Booking.js").default;
    const InventoryContainer = require("../models/InventoryContainer.js").default;
    const [bookingRows, legacyRows] = await Promise.all([
        Booking.aggregate(buildStorageOccupancyPipeline({
            areaField: "assignedArea",
            blockField: "assignedBlock",
            statuses: STORED_BOOKING_STATUSES,
        })),
        InventoryContainer.aggregate(buildStorageOccupancyPipeline({
            areaField: "area",
            blockField: "block",
            statuses: STORED_LEGACY_STATUSES,
        })),
    ]);
    return summarizeStorageOccupancy([...bookingRows, ...legacyRows]);
};

module.exports = {
    STORED_BOOKING_STATUSES,
    STORED_LEGACY_STATUSES,
    buildStorageOccupancyPipeline,
    summarizeStorageOccupancy,
    loadStorageOccupancy,
};
