"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const AREA_ID = "64be51a33333333333333333";
const SECOND_AREA = "64be51a44444444444444444";
const BLOCK_ID = "64be51b55555555555555555";
const mkResponse = () => ({
    statusCode: 200, payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return payload; },
});

const loadApi = ({ areas = [], blocks = [], positions = [], occupancy = null } = {}) => {
    const calls = { areaList: 0, blockList: 0, findArea: [], findBlocks: [], occupancy: 0, visual: [], tables: [] };
    const areaModel = {
        find: () => {
            calls.areaList++;
            const query = {
                select() { return this; }, sort() { return this; },
                async lean() { return areas; },
            };
            return query;
        },
        findById: (id) => {
            calls.findArea.push(id);
            const query = {
                select() { return this; },
                async lean() { return areas.find((row) => String(row._id) === id) || null; },
            };
            return query;
        },
    };
    const blockModel = {
        find: (filter) => {
            if (filter === undefined) calls.blockList++;
            else calls.findBlocks.push(filter);
            const query = {
                select() { return this; }, sort() { return this; },
                async lean() { return filter ? blocks.filter((block) => String(block.area) === filter.area) : blocks; },
            };
            return query;
        },
    };
    const storage = {
        listStoredContainers: async (req, res) => {
            calls.tables.push(req.query);
            return res.json({ success: true, containers: [{ id: "stored-1" }], pagination: { total: 1, page: 1 } });
        },
        loadVisualization: async (params) => {
            calls.visual.push(params);
            return { visualContainers: positions, visualizationTruncated: false };
        },
    };
    const modules = {
        "../models/YardArea.js": { default: areaModel },
        "../models/YardBlock.js": { default: blockModel },
        "../utils/storageOccupancy.js": { loadStorageOccupancy: async () => {
            calls.occupancy++;
            return occupancy || {
                totalContainers: 60, totalTeu: 80,
                areas: [{ areaId: AREA_ID, containerCount: 60, usedTeu: 80 }],
                blocks: [{ areaId: AREA_ID, blockId: BLOCK_ID, containerCount: 60, usedTeu: 80 }],
            };
        } },
        "./storageController.js": storage,
    };
    const filepath = path.join(__dirname, "../controllers/storageMonitoringController.js");
    const code = fs.readFileSync(filepath, "utf8");
    const underTest = { exports: {} };
    vm.runInNewContext(code, {
        module: underTest, exports: underTest.exports,
        require(name) { assert.ok(name in modules, `Unexpected require: ${name}`); return modules[name]; },
        console,
    }, { filename: filepath });
    return { api: underTest.exports, calls };
};

const area = (id, name = "Yard A") => ({
    _id: id, name, code: name === "Yard A" ? "YA" : "YB",
    lineCount: 8, rowCount: 6, tierCount: 3,
    containerSize: 20, capacityTeu: 144, status: "active",
});
const block = (id, areaId) => ({
    _id: id, area: areaId, code: "BA", name: "Block A",
    bayCount: 8, rowCount: 6, tierCount: 3, teuSlots: 144,
    occupiedSlots: 5, x: 20, y: 40, width: 220, height: 180,
});

test("yard list returns all areas, occupancy, and lightweight block options in one response", async () => {
    const { api, calls } = loadApi({
        areas: [area(AREA_ID), area(SECOND_AREA, "Yard B")],
        blocks: [block(BLOCK_ID, AREA_ID)],
    });
    const res = mkResponse();
    await api.listStorageYardAreas({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.storageApiVersion, 6);
    assert.equal(res.payload.areas.length, 2);
    assert.equal(res.payload.areas[0].blockCount, 1);
    assert.equal(res.payload.areas[0].totalTeuSlots, 144);
    assert.equal(res.payload.areas[1].blockCount, 0);
    assert.equal(res.payload.filterBlocks.length, 1);
    assert.equal(res.payload.filterBlocks[0].area, AREA_ID);
    assert.equal(res.payload.storageOccupancy.totalContainers, 60);
    assert.deepEqual(calls.visual, []);
    assert.deepEqual(calls.tables, []);
    assert.deepEqual(calls.findBlocks, []);
    assert.equal(calls.occupancy, 1);
});

test("empty yard overview returns a valid all-areas response with zero totals", async () => {
    const { api } = loadApi({ occupancy: { areas: [], blocks: [], totalContainers: 0 } });
    const res = mkResponse();
    await api.listStorageYardAreas({}, res);
    assert.equal(res.payload.areas.length, 0);
    assert.equal(res.payload.filterBlocks.length, 0);
    assert.equal(res.payload.storageOccupancy.totalContainers, 0);
});

test("3D endpoint validates area ID before any DB work", async () => {
    const { api, calls } = loadApi({ areas: [area(AREA_ID)] });
    const res = mkResponse();
    await api.getStorageYardSlotMap({ params: { areaId: "hello" } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.findArea.length, 0);
    assert.equal(calls.visual.length, 0);
    assert.equal(calls.blockList, 0);
});

test("missing area returns 404 and never downloads 3D rows", async () => {
    const { api, calls } = loadApi({ areas: [] });
    const res = mkResponse();
    await api.getStorageYardSlotMap({ params: { areaId: AREA_ID } }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(calls.findArea.length, 1);
    assert.equal(calls.visual.length, 0);
    assert.equal(calls.findBlocks.length, 0);
});

test("selected yard returns blocks and ALL 5200 selected-yard positions, with no table call", async () => {
    const positions = Array.from({ length: 5200 }, (_, i) => ({
        id: `stored-${i}`, area: AREA_ID, block: BLOCK_ID,
        bay: 1, row: 1, tier: i + 1,
    }));
    const { api, calls } = loadApi({
        areas: [area(AREA_ID), area(SECOND_AREA, "Yard B")],
        blocks: [block(BLOCK_ID, AREA_ID), block("64be51b66666666666666666", SECOND_AREA)],
        positions,
    });
    const res = mkResponse();
    await api.getStorageYardSlotMap({ params: { areaId: AREA_ID } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.storageApiVersion, 6);
    assert.equal(res.payload.area.id, AREA_ID);
    assert.equal(res.payload.blocks.length, 1);
    assert.equal(res.payload.blocks[0].id, BLOCK_ID);
    assert.equal(res.payload.visualContainers.length, 5200);
    assert.equal(res.payload.visualizationTruncated, false);
    assert.equal(calls.occupancy, 0, "never rescan occupancy for area selection");
    assert.deepEqual(calls.tables, []);
    assert.equal(calls.visual.length, 1);
    assert.equal(calls.visual[0].full, true);
    assert.equal(calls.visual[0].areaId, AREA_ID);
});

test("storage-list endpoint explicitly disables visualization and unpaginated flags", async () => {
    const { api, calls } = loadApi();
    const res = mkResponse();
    await api.listStorageContainers({ query: {
        page: "3", limit: "25", visualizationOnly: "true",
        includeVisualization: "true", unpaginated: "true",
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.tables.length, 1);
    assert.equal(calls.tables[0].page, "3");
    assert.equal(calls.tables[0].limit, "25");
    assert.equal(calls.tables[0].visualizationOnly, "false");
    assert.equal(calls.tables[0].includeVisualization, "false");
    assert.equal(calls.tables[0].unpaginated, "false");
});

test("admin route protects all new endpoints with inventory.view permission", () => {
    const routes = fs.readFileSync(path.join(__dirname, "../routes/adminRoutes.js"), "utf8");
    const lines = routes.split("\n").filter((line) => line.includes('router.get("/storage-monitoring/'));
    assert.equal(lines.length, 3);
    assert.ok(lines.every((line) => line.includes('requirePermission)("inventory", "view")')));
});

test("storage list rejects invalid area/block filters before MongoDB casts", async () => {
    const { api, calls } = loadApi();
    const res = mkResponse();
    await api.listStorageContainers({ query: { areaId: "not-a-valid-id" } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.tables.length, 0);
});
