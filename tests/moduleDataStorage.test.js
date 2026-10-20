"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function mockModuleData({ occupancy }) {
    const calls = { inventory: [], blocks: [], occupancy: 0, clients: 0, yardSummary: 0 };
    const storageOccupancy = occupancy || {
        areas: [{ areaId: "yard-1", containerCount: 5, usedTeu: 7 }],
        blocks: [{ areaId: "yard-1", blockId: "block-1", containerCount: 5, usedTeu: 7 }],
        totalContainers: 5, totalTeu: 7, assignedContainers: 5, assignedTeu: 7,
        unassignedContainers: 0,
    };
    const models = {
        "./inventoryController.js": {
            listInventoryContainers: async (req, res) => {
                calls.inventory.push({ ...req.query });
                res.json({
                    containers: [{ id: "stored-1", area: "yard-1" }],
                    visualContainers: req.query.includeVisualization === "true"
                        ? [{ id: "stored-1", area: "yard-1", block: "block-1" }] : [],
                    pagination: { page: 1, total: 5, totalPages: 1 },
                });
            },
            listInventoryClients: async (req, res) => { calls.clients++; return res.json({ clients: [] }); },
        },
        "./yardController.js": {
            listYardAreas: async (req, res) => res.json({ areas: [{ id: "yard-1", name: "Area One" }] }),
            getYardSummary: async (req, res) => { calls.yardSummary++; return res.json({ summary: {} }); },
            listYardBlocks: async (req, res) => {
                calls.blocks.push(req.params.areaId);
                res.json({ blocks: [{ id: "block-1", area: req.params.areaId }] });
            },
        },
        "./bookingController.js": {},
        "../utils/storageOccupancy.js": {
            loadStorageOccupancy: async () => {
                calls.occupancy++;
                return storageOccupancy;
            },
        },
    };
    const exported = {};
    const context = {
        exports: exported,
        module: { exports: exported },
        require(request) {
            assert.ok(models[request], `Unexpected import: ${request}`);
            return models[request];
        },
    };
    const code = fs.readFileSync(path.join(__dirname, "../controllers/moduleDataController.js"), "utf8");
    vm.runInNewContext(code, context, { filename: "moduleDataController.js" });
    return { moduleData: exported, calls };
}

const makeResponse = () => {
    const response = { payload: null };
    response.json = (payload) => { response.payload = payload; return payload; };
    return response;
};

test("unfiltered storage overview returns yard metadata plus full-area storage occupancy", async () => {
    const { moduleData, calls } = mockModuleData({});
    const response = makeResponse();
    await moduleData.getInventoryModuleData({ query: {
        view: "storage", includeMeta: "true", includeStorageOccupancy: "true",
    } }, response);
    assert.equal(response.payload.areas[0].id, "yard-1");
    assert.equal(response.payload.storageOccupancy.areas[0].containerCount, 5);
    assert.equal(calls.occupancy, 1);
    assert.equal(calls.blocks.length, 0);
});

test("search, paging and block filtering keep independent occupancy and visual area allocations", async () => {
    const { moduleData, calls } = mockModuleData({});
    const response = makeResponse();
    await moduleData.getInventoryModuleData({ query: {
        view: "storage", areaId: "yard-1", blockId: "block-1", search: "xyz",
        page: "2", loadStatus: "laden", includeVisualization: "true", includeStorageOccupancy: "true",
    } }, response);
    assert.equal(calls.inventory[0].search, "xyz");
    assert.deepEqual(calls.blocks, ["yard-1"]);
    assert.equal(response.payload.visualContainers.length, 1);
    assert.equal(response.payload.storageOccupancy.totalContainers, 5);
    assert.equal(calls.occupancy, 1);
});

test("ordinary inventory queries do not trigger extra storage occupancy aggregations", async () => {
    const { moduleData, calls } = mockModuleData({});
    const response = makeResponse();
    await moduleData.getInventoryModuleData({ query: {
        view: "inventory", includeStorageOccupancy: "true",
    } }, response);
    assert.equal(calls.occupancy, 0);
    assert.ok(!("storageOccupancy" in response.payload));
});

test("summary-only storage overview skips the expensive container listing completely", async () => {
    const { moduleData, calls } = mockModuleData({});
    const response = makeResponse();
    await moduleData.getInventoryModuleData({ query: {
        view: "storage", summaryOnly: "true", includeMeta: "true", includeStorageOccupancy: "true", page: "1", limit: "1",
    } }, response);
    assert.equal(calls.inventory.length, 0);
    assert.equal(calls.blocks.length, 0);
    assert.equal(calls.clients, 0);
    assert.equal(calls.yardSummary, 0);
    assert.equal(calls.occupancy, 1);
    assert.equal(response.payload.areas[0].id, "yard-1");
    assert.equal(response.payload.storageOccupancy.totalContainers, 5);
    assert.equal("containers" in response.payload, false);
});
