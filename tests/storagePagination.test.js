"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../controllers/inventoryController.js"), "utf8");
const records = Array.from({ length: 205 }, (_, idx) => ({
    _id: `id-${idx}`,
    containerNumber: `CONT${idx}`,
    containerSize: idx % 2 ? 40 : 20,
    status: "stored_in_assigned_area",
    assignedArea: "A",
    assignedBlock: "B",
}));

function buildMockController() {
    const calls = { pipelines: [], ids: [] };
    const chain = (getValue) => {
        const obj = {
            select() { return this; },
            populate() { return this; },
            sort() { return this; },
            skip() { return this; },
            limit() { return this; },
            lean: async () => getValue(),
        };
        return obj;
    };
    const bookingModel = {
        countDocuments: async () => records.length,
        find: (query) => chain(() => {
            const ids = new Set(query._id.$in.map(String));
            calls.ids.push(ids.size);
            return records.filter((item) => ids.has(item._id));
        }),
        collection: { name: "bookings" },
    };
    const legacyModel = {
        countDocuments: async () => 0,
        aggregate: async (pipeline) => {
            calls.pipelines.push(pipeline);
            const skip = pipeline.find((stage) => stage.$skip !== undefined)?.$skip || 0;
            const limit = pipeline.find((stage) => stage.$limit !== undefined)?.$limit;
            const refs = records.map((record) => ({ _id: record._id, source: "booking" }));
            return limit ? refs.slice(skip, skip + limit) : refs.slice(skip);
        },
    };
    const mocks = {
        "../models/InventoryContainer.js": legacyModel,
        "../models/Booking.js": bookingModel,
        "../models/PreAdvice.js": {},
        "../models/User.js": {},
        "../models/YardArea.js": {},
        "../models/YardBlock.js": {},
        "../socket/socket.js": {},
        "./bookingController.js": {},
        "../utils/bookingNumber.js": {},
        "../utils/localFileStorage.js": {},
        "../utils/notificationService.js": {},
    };
    const exports = {};
    vm.runInNewContext(source, {
        exports,
        module: { exports },
        require: (file) => {
            assert.ok(file in mocks, `Unexpected module ${file}`);
            return mocks[file];
        },
        process: { env: {} },
        console,
    }, { filename: "inventoryController.js" });
    return { handler: exports.listInventoryContainers, calls };
}

const response = () => {
    const result = { payload: null };
    result.json = (payload) => { result.payload = payload; return payload; };
    return result;
};

test("storage view always applies server-side page and limit even if an old client requests unpaginated", async () => {
    const { handler, calls } = buildMockController();
    const res = response();
    await handler({ query: { view: "storage", unpaginated: "true", page: "2", limit: "25" } }, res);
    assert.equal(res.payload.containers.length, 25);
    assert.equal(res.payload.pagination.total, 205);
    assert.equal(res.payload.pagination.page, 2);
    assert.equal(res.payload.pagination.limit, 25);
    assert.equal(res.payload.pagination.totalPages, 9);
    assert.equal(calls.pipelines[0].find((stage) => "$skip" in stage).$skip, 25);
    assert.equal(calls.pipelines[0].find((stage) => "$limit" in stage).$limit, 25);
    assert.equal(calls.ids.at(-1), 25);
});

test("storage page 9 fetches only the remaining 5 records", async () => {
    const { handler, calls } = buildMockController();
    const res = response();
    await handler({ query: { view: "storage", page: "9", limit: "25" } }, res);
    assert.equal(res.payload.containers.length, 5);
    assert.equal(res.payload.pagination.totalPages, 9);
    assert.equal(calls.pipelines.length, 1);
});

test("regular inventory pagination remains limited to 100 records", async () => {
    const { handler, calls } = buildMockController();
    const res = response();
    await handler({ query: { view: "inventory", unpaginated: "true", limit: "500" } }, res);
    assert.equal(res.payload.containers.length, 100);
    assert.equal(res.payload.pagination.totalPages, 3);
    assert.equal(calls.pipelines[0].find((item) => item.$limit !== undefined).$limit, 100);
});
