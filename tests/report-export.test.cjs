"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { csvLine } = require("../utils/reportCsv.js");

const clientId = "507f1f77bcf86cd799439011";
const records = Array.from({ length: 1205 }, (_, index) => ({
  _id: `id-${index}`,
  reportNumber: `REL-${String(index).padStart(5, "0")}`,
  client: { _id: clientId, companyName: index === 0 ? "=HYPERLINK(\"fake\")" : "Sample Company" },
  booking: { _id: `b-${index}`, paymentTransactions: [], billingTotal: 30 },
  containerNumber: `CONT${index}`,
  containerSize: 20,
  containerLoadStatus: "empty",
  rateType: "local",
  releasedAt: new Date("2026-11-01T04:00:00Z"),
  totalPaidAmount: 30,
  gateInPaymentTotal: 10,
  gateOutPaymentTotal: 20,
  totalBillingAmount: 30,
  billingSubtotal: 25,
  vatAmount: 5,
}));
let capturedQuery;
let skipCalled = 0;
let limitCalled = 0;
let cursorClosed = false;
const list = {
  populate: () => list,
  sort: () => list,
  skip: (n) => { skipCalled = n; return list; },
  limit: (n) => { limitCalled = n; return list; },
  lean: () => list,
  then: (resolve, reject) => Promise.resolve(records.slice(skipCalled, skipCalled + limitCalled)).then(resolve, reject),
  cursor: () => ({
    async *[Symbol.asyncIterator]() { for (const record of records) yield record; },
    close: async () => { cursorClosed = true; },
  }),
};
const fakeRelease = {
  find: (query) => { capturedQuery = query; return list; },
  countDocuments: async () => records.length,
};
const reportService = {
  parseReportFilters: (filters) => ({
    startDate: filters.startDate || "", endDate: filters.endDate || "",
    clientId: filters.clientId || "", loadStatus: filters.loadStatus || "all",
    rateType: filters.rateType || "all", recordSource: filters.recordSource || "all",
  }),
  buildReportQueries: (filters) => ({ releaseQuery: { client: filters.clientId, containerLoadStatus: filters.loadStatus } }),
  getYardOverview: async () => ({ clientRevenue: [] }),
  parsePage: (page, pageSize) => ({ page: Number(page) || 1, pageSize: Number(pageSize) || 10 }),
};
const exported = {};
const source = fs.readFileSync(path.join(__dirname, "../controllers/reportController.js"), "utf8");
vm.runInNewContext(source, {
  exports: exported,
  require: (name) => {
    if (name === "../models/Booking.js") return { __esModule: true, default: {} };
    if (name === "../models/User.js") return { __esModule: true, default: {} };
    if (name === "../models/YardBlock.js") return { __esModule: true, default: {} };
    if (name === "../models/ReleaseReport.js") return { __esModule: true, default: fakeRelease };
    if (name === "../utils/adminMetrics.js") return {};
    if (name === "../services/yardReportService.js") return reportService;
    if (name === "../utils/reportCsv.js") return { csvLine };
    throw new Error(`Unexpected import ${name}`);
  },
  Date, Intl, Number, String, Object, Math, Array, process: { env: {} },
});

const response = () => {
  const res = new EventEmitter();
  res.headers = {};
  res.body = "";
  res.destroyed = false;
  res.writableEnded = false;
  res.setHeader = (key, value) => { res.headers[key] = value; };
  res.write = (str) => { res.body += str; return true; };
  res.end = () => { res.writableEnded = true; };
  res.json = (value) => { res.payload = value; };
  return res;
};

test("table endpoint returns one page while advertising the full filtered count", async () => {
  const res = response();
  await exported.getReportsReleases({ query: { clientId, loadStatus: "empty", page: "2", pageSize: "10" } }, res);
  assert.equal(res.payload.pagination.totalItems, 1205);
  assert.equal(res.payload.items.length, 10);
  assert.equal(res.payload.items[0].reportNumber, "REL-00010");
  assert.equal(capturedQuery.client, clientId);
});

test("CSV exports ALL 1,205 filtered records, not table page or old 1,000 cap", async () => {
  cursorClosed = false;
  const res = response();
  await exported.exportReportsCsv({ query: { section: "releases", clientId, loadStatus: "empty", page: "2", pageSize: "10" } }, res);
  assert.equal((res.body.match(/"REL-\d{5}"/g) || []).length, 1205);
  assert.ok(res.body.includes("REL-01204"));
  assert.ok(res.body.includes('"\'=HYPERLINK(""fake"")"'));
  assert.match(res.headers["Content-Type"], /csv/);
  assert.equal(cursorClosed, true);
  assert.equal(res.writableEnded, true);
  assert.equal(capturedQuery.client, clientId);
});
