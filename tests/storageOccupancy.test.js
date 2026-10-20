"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
    STORED_BOOKING_STATUSES,
    STORED_LEGACY_STATUSES,
    buildStorageOccupancyPipeline,
    summarizeStorageOccupancy,
} = require("../utils/storageOccupancy.js");

test("storage counts exclude bookings still awaiting storage and containers already released", () => {
    assert.ok(STORED_BOOKING_STATUSES.includes("stored_in_assigned_area"));
    assert.ok(STORED_BOOKING_STATUSES.includes("gate_out_requested"));
    assert.ok(!STORED_BOOKING_STATUSES.includes("gate_in_approved"));
    assert.ok(!STORED_BOOKING_STATUSES.includes("completed_gate_out_done"));
    assert.ok(STORED_LEGACY_STATUSES.includes("in_yard"));
    assert.ok(!STORED_LEGACY_STATUSES.includes("released"));
});

test("the booking and legacy pipelines each aggregate by the correct area and block fields", () => {
    const booking = buildStorageOccupancyPipeline({
        areaField: "assignedArea", blockField: "assignedBlock", statuses: STORED_BOOKING_STATUSES,
    });
    const legacy = buildStorageOccupancyPipeline({
        areaField: "area", blockField: "block", statuses: STORED_LEGACY_STATUSES,
    });
    assert.deepEqual(booking[0].$match.status.$in, STORED_BOOKING_STATUSES);
    assert.deepEqual(booking[1].$group._id, { area: "$assignedArea", block: "$assignedBlock" });
    assert.deepEqual(legacy[1].$group._id, { area: "$area", block: "$block" });
    assert.deepEqual(booking[1].$group.usedTeu.$sum.$cond, [
        { $in: ["$containerSize", [40, "40"]] }, 2, 1,
    ]);
});

test("per-area and per-block counts combine both data sources without mixing yards", () => {
    const rows = [
        { _id: { area: "AREA-1", block: "A-1" }, containerCount: 2, usedTeu: 3 },
        { _id: { area: "AREA-1", block: "A-1" }, containerCount: 1, usedTeu: 1 },
        { _id: { area: "AREA-1", block: "A-2" }, containerCount: 1, usedTeu: 2 },
        { _id: { area: "AREA-2", block: "B-1" }, containerCount: 3, usedTeu: 5 },
        { _id: { area: "AREA-2", block: null }, containerCount: 1, usedTeu: 2 },
        { _id: { area: null, block: null }, containerCount: 1, usedTeu: 1 },
    ];
    const result = summarizeStorageOccupancy(rows);
    assert.equal(result.totalContainers, 9);
    assert.equal(result.totalTeu, 14);
    assert.equal(result.assignedContainers, 8);
    assert.equal(result.assignedTeu, 13);
    assert.equal(result.unassignedContainers, 1);
    assert.deepEqual(result.areas, [
        { areaId: "AREA-1", containerCount: 4, usedTeu: 6 },
        { areaId: "AREA-2", containerCount: 4, usedTeu: 7 },
    ]);
    assert.deepEqual(result.blocks, [
        { areaId: "AREA-1", blockId: "A-1", containerCount: 3, usedTeu: 4 },
        { areaId: "AREA-1", blockId: "A-2", containerCount: 1, usedTeu: 2 },
        { areaId: "AREA-2", blockId: "B-1", containerCount: 3, usedTeu: 5 },
    ]);
});

test("empty yards remain zero in the frontend lookup and no records create zero totals", () => {
    const result = summarizeStorageOccupancy([]);
    assert.deepEqual(result.areas, []);
    assert.deepEqual(result.blocks, []);
    assert.equal(result.totalContainers, 0);
    assert.equal(result.assignedTeu, 0);
    assert.equal(result.unassignedContainers, 0);
});
