"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { planStoragePage } = require("../utils/storagePagination.js");

const booking = (index) => ({
    _id: `booking-${index}`,
    status: "stored_in_assigned_area",
    assignedArea: { _id: index % 3 === 0 ? "yard-b" : "yard-a", name: index % 3 === 0 ? "Yard B" : "Yard A" },
    assignedBlock: { _id: "block-a", name: "Block A", code: "BA" },
    containerNumber: `B-${index}`,
    containerSize: 20,
    containerLoadStatus: index % 2 ? "laden" : "empty",
    rateType: "local",
    bookingReference: `OTLI-${index}`,
    client: { _id: "client-a", companyName: "Client A" },
    updatedAt: new Date(2025, 0, 1 + index),
    createdAt: new Date(2025, 0, 1 + index),
});
const legacy = (index) => ({
    _id: `legacy-${index}`,
    status: "in_yard",
    area: { _id: "yard-a", name: "Yard A" },
    block: { _id: "block-a", name: "Block A", code: "BA" },
    containerNumber: `L-${index}`,
    containerSize: 40,
    containerStatus: "empty",
    rateType: "local",
    client: { _id: "client-b", companyName: "Client B" },
    storageStartDate: new Date(2025, 1, 1 + index),
    updatedAt: new Date(2025, 1, 1 + index),
    createdAt: new Date(2025, 1, 1 + index),
});

const value = (document, key) => {
    const raw = document[key];
    return raw && typeof raw === "object" && "_id" in raw ? raw._id : raw;
};
const matches = (document, query) => Object.entries(query).every(([key, expected]) => {
    if (key === "$or") return expected.some((item) => matches(document, item));
    const actual = value(document, key);
    if (expected && typeof expected === "object" && !(expected instanceof RegExp)) {
        if (Array.isArray(expected.$in)) return expected.$in.includes(actual);
    }
    if (expected instanceof RegExp) return expected.test(String(actual ?? ""));
    return actual === expected;
});

function mockModel(source, name, stats) {
    return {
        countDocuments: async (query) => {
            stats.count.push({ name, query });
            return source.filter((row) => matches(row, query)).length;
        },
        find: (query) => {
            stats.find.push({ name, query });
            const state = { sort: null, skip: 0, limit: Infinity };
            const chain = {
                select(fields) { stats.select.push({ name, fields }); return chain; },
                populate() { return chain; },
                sort(fields) { state.sort = fields; return chain; },
                skip(value) { state.skip = value; return chain; },
                limit(value) { state.limit = value; return chain; },
                async lean() {
                    let rows = source.filter((row) => matches(row, query));
                    if (state.sort) {
                        const entries = Object.entries(state.sort);
                        rows = rows.slice().sort((a, b) => {
                            for (const [field, direction] of entries) {
                                const av = a[field] instanceof Date ? a[field].getTime() : String(a[field]);
                                const bv = b[field] instanceof Date ? b[field].getTime() : String(b[field]);
                                if (av !== bv) return av < bv ? -direction : direction;
                            }
                            return 0;
                        });
                    }
                    stats.queries.push({ name, sort: state.sort, skip: state.skip, limit: state.limit, returned: rows.slice(state.skip, state.skip + state.limit).length });
                    return rows.slice(state.skip, state.skip + state.limit);
                },
            };
            return chain;
        },
    };
}

function createHarness({ bookings = [], legacyRows = [] } = {}) {
    const stats = { count: [], find: [], select: [], queries: [] };
    const Booking = mockModel(bookings, "booking", stats);
    const InventoryContainer = mockModel(legacyRows, "legacy", stats);
    const User = mockModel([], "user", stats);
    const YardArea = mockModel([], "yard", stats);
    const filename = path.join(__dirname, "../controllers/storageController.js");
    const moduleUnderTest = { exports: {} };
    const fakeModules = {
        "../models/Booking.js": { default: Booking },
        "../models/InventoryContainer.js": { default: InventoryContainer },
        "../models/User.js": { default: User },
        "../models/YardArea.js": { default: YardArea },
        "../utils/storageOccupancy.js": require("../utils/storageOccupancy.js"),
        "../utils/storagePagination.js": require("../utils/storagePagination.js"),
    };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
        module: moduleUnderTest, exports: moduleUnderTest.exports,
        require: (name) => {
            assert.ok(name in fakeModules, `Unexpected import: ${name}`);
            return fakeModules[name];
        },
        process: { env: {} }, console, Date,
    }, { filename });
    const handler = moduleUnderTest.exports;
    const call = async (params = {}) => {
        const res = {
            payload: null, statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.payload = payload; return payload; },
        };
        await handler.listStoredContainers({ query: params }, res);
        return res;
    };
    return { call, stats, handler };
}

test("planner creates accurate bounded pages at mixed-source boundaries", () => {
    const first = planStoragePage({ bookingTotal: 12, legacyTotal: 31, requestedPage: 1, limit: 10 });
    const second = planStoragePage({ bookingTotal: 12, legacyTotal: 31, requestedPage: 2, limit: 10 });
    const last = planStoragePage({ bookingTotal: 12, legacyTotal: 31, requestedPage: 100, limit: 10 });
    assert.deepEqual(first.booking, { skip: 0, limit: 10 });
    assert.deepEqual(first.legacy, { skip: 0, limit: 0 });
    assert.deepEqual(second.booking, { skip: 10, limit: 2 });
    assert.deepEqual(second.legacy, { skip: 0, limit: 8 });
    assert.equal(last.page, 5);
    assert.deepEqual(last.booking, { skip: 12, limit: 0 });
    assert.deepEqual(last.legacy, { skip: 28, limit: 3 });
});

test("planner is correct across many combinations of booking and legacy counts", () => {
    for (let bookingTotal = 0; bookingTotal <= 35; bookingTotal += 5) {
        for (let legacyTotal = 0; legacyTotal <= 35; legacyTotal += 5) {
            for (const limit of [1, 7, 10, 25]) {
                const ids = [];
                const totalPages = Math.max(1, Math.ceil((bookingTotal + legacyTotal) / limit));
                for (let page = 1; page <= totalPages; page++) {
                    const plan = planStoragePage({ bookingTotal, legacyTotal, requestedPage: page, limit });
                    for (let idx = plan.booking.skip; idx < plan.booking.skip + plan.booking.limit; idx++) ids.push(`B${idx}`);
                    for (let idx = plan.legacy.skip; idx < plan.legacy.skip + plan.legacy.limit; idx++) ids.push(`L${idx}`);
                }
                assert.equal(ids.length, bookingTotal + legacyTotal);
                assert.equal(new Set(ids).size, ids.length);
                assert.equal(ids.at(-1), legacyTotal > 0 ? `L${legacyTotal - 1}` : bookingTotal > 0 ? `B${bookingTotal - 1}` : undefined);
            }
        }
    }
});

test("API page 2 at a source boundary returns records instead of a blank table", async () => {
    const harness = createHarness({ bookings: Array.from({ length: 12 }, (_, i) => booking(i)), legacyRows: Array.from({ length: 31 }, (_, i) => legacy(i)) });
    const { payload } = await harness.call({ view: "storage", page: "2", limit: "10" });
    assert.equal(payload.success, true);
    assert.equal(payload.containers.length, 10);
    assert.equal(payload.containers.filter((row) => row.source === "booking").length, 2);
    assert.equal(payload.containers.filter((row) => row.source === "pre_advice").length, 8);
    assert.equal(payload.pagination.total, 43);
    assert.equal(payload.storageApiVersion, 6);
    assert.equal(payload.pagination.page, 2);
    assert.equal(payload.pagination.totalPages, 5);
    assert.equal(harness.stats.count.length, 2);
    assert.deepEqual(harness.stats.queries.map((row) => row.limit), [2, 8]);
    assert.ok(harness.stats.queries.every((row) => row.skip < 10 || row.limit <= 2));
});

test("API page 5 returns final partial page, and out-of-range requests clamp with actual rows", async () => {
    const harness = createHarness({ bookings: Array.from({ length: 12 }, (_, i) => booking(i)), legacyRows: Array.from({ length: 31 }, (_, i) => legacy(i)) });
    const last = (await harness.call({ page: "5", limit: "10" })).payload;
    assert.equal(last.containers.length, 3);
    assert.equal(last.pagination.page, 5);
    const out = (await harness.call({ page: "999", limit: "10" })).payload;
    assert.equal(out.containers.length, 3);
    assert.equal(out.pagination.page, 5);
    const oldFlag = (await harness.call({ unpaginated: "true", page: "1", limit: "10" })).payload;
    assert.equal(oldFlag.containers.length, 10);
    assert.ok(harness.stats.queries.every((row) => row.limit <= 10));
});

test("API filter applies to both sources and changes pagination totals", async () => {
    const harness = createHarness({ bookings: Array.from({ length: 12 }, (_, i) => booking(i)), legacyRows: Array.from({ length: 31 }, (_, i) => legacy(i)) });
    const onlyA = (await harness.call({ page: "3", limit: "5", areaId: "yard-a" })).payload;
    assert.equal(onlyA.pagination.total, 8 + 31);
    assert.equal(onlyA.containers.length, 5);
    assert.ok(onlyA.containers.every((row) => row.area === "yard-a"));
    const empty = (await harness.call({ page: "1", limit: "10", blockId: "none" })).payload;
    assert.equal(empty.containers.length, 0);
    assert.equal(empty.pagination.total, 0);
    assert.equal(empty.pagination.page, 1);
});

test("visualization-only fetch skips counts and pagination, applies yard filter, and respects combined limit", async () => {
    const harness = createHarness({ bookings: Array.from({ length: 12 }, (_, i) => booking(i)), legacyRows: Array.from({ length: 31 }, (_, i) => legacy(i)) });
    const response = await harness.call({ view: "storage", visualizationOnly: "true", areaId: "yard-a", visualizationLimit: "15" });
    assert.equal(response.payload.visualContainers.length, 15);
    assert.equal(response.payload.visualizationTruncated, true);
    assert.equal(response.payload.storageApiVersion, 6);
    assert.ok(response.payload.visualContainers.every((row) => row.area === "yard-a"));
    assert.equal(harness.stats.count.length, 0);
    assert.equal(harness.stats.queries.length, 2);
    assert.ok(harness.stats.queries.every((query) => query.limit === 16));
    assert.ok(!("containers" in response.payload));
});

test("visualization-only refuses missing area instead of fetching the entire yard", async () => {
    const harness = createHarness({ bookings: [booking(1)] });
    const response = await harness.call({ visualizationOnly: "true" });
    assert.equal(response.statusCode, 400);
    assert.equal(harness.stats.count.length, 0);
    assert.equal(harness.stats.queries.length, 0);
});

test("nested Mongo-style query operators are rejected before querying collections", async () => {
    const harness = createHarness({ bookings: [booking(1)] });
    const response = await harness.call({ areaId: { $ne: null } });
    assert.equal(response.statusCode, 400);
    assert.equal(harness.stats.count.length, 0);
});

test("regular inventory dispatch is unchanged, while storage is routed to specialized controller", () => {
    const inventory = fs.readFileSync(path.join(__dirname, "../controllers/inventoryController.js"), "utf8");
    assert.match(inventory, /return require\("\.\/storageController\.js"\)\.listStoredContainers\(req, res\)/);
    assert.match(inventory, /const listInventoryContainers = async/);
});

test("trusted selected-yard visualization loads beyond the legacy 5000-record cap", async () => {
    const harness = createHarness({
        bookings: Array.from({ length: 5100 }, (_, i) => ({
            ...booking(i), assignedArea: { _id: "yard-a", name: "Yard A" },
        })),
        legacyRows: Array.from({ length: 175 }, (_, i) => legacy(i)),
    });
    const result = await harness.handler.loadVisualization({
        areaId: "yard-a", source: "all", full: true,
    });
    assert.equal(result.visualContainers.length, 5275);
    assert.equal(result.visualizationTruncated, false);
    assert.ok(harness.stats.queries.every((query) => query.limit === Infinity));
    assert.equal(harness.stats.count.length, 0, "full 3D must not run table counts");
});
