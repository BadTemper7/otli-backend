"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  safeRecipientMask, classifySmtpFailure, parseReportRange, parseHistoryOptions,
  manilaDate, recordRegistrationEmailEvent, summarizeBuckets,
  getEmailMonitoringReport, csvRecord,
} = require("../utils/registrationEmailHistory.js");
const source = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");

// Minimal MongoDB collection fake: no credentials, live database or email sends.
class FakeEvents {
  records = [];
  insertOne = async (doc) => { this.records.push({ ...doc, _id: String(this.records.length + 1) }); return { insertedId: this.records.length }; };
  updateOne = async (query, update) => {
    let item = this.records.find((doc) => doc._id === query._id);
    if (!item) {
      item = { _id: query._id, ...update.$setOnInsert, count: 0 };
      this.records.push(item);
    }
    item.count += update.$inc.count;
    return { matchedCount: 1 };
  };
  match(query) {
    return this.records.filter((r) => r.createdAt >= query.createdAt.$gte && r.createdAt < query.createdAt.$lt && (!query.eventType || r.eventType === query.eventType));
  }
  countDocuments = async (query) => this.match(query).length;
  find(query) {
    let items = this.match(query);
    return {
      sort() { items.sort((a, b) => b.createdAt - a.createdAt || b._id.localeCompare(a._id)); return this; },
      skip(n) { items = items.slice(n); return this; },
      limit(n) { items = items.slice(0, n); return this; },
      async toArray() { return items; },
    };
  }
  aggregate(pipeline) {
    const entries = this.match(pipeline[0].$match);
    const grouped = new Map();
    for (const row of entries) {
      const date = manilaDate(row.createdAt.getTime());
      const key = `${date}:${row.eventType}`;
      if (!grouped.has(key)) grouped.set(key, { _id: { date, eventType: row.eventType }, count: 0 });
      grouped.get(key).count += row.count || 1;
    }
    return { async toArray() { return [...grouped.values()]; } };
  }
}

test("stores only masked recipient addresses and safe SMTP codes", async () => {
  const collection = new FakeEvents();
  assert.equal(safeRecipientMask("Person.Name@Gmail.Com"), "p***@g***.com");
  await recordRegistrationEmailEvent({ collection, eventType: "smtp_unconfirmed", flow: "resend_otp", recipient: "private.person@company.test", errorCode: "password=secret", now: () => Date.UTC(2026, 9, 31) });
  const stored = JSON.stringify(collection.records);
  assert.doesNotMatch(stored, /private\.person@company\.test|password=secret|123456/);
  assert.match(stored, /p\*\*\*@c\*\*\*\.test/);
  assert.equal(collection.records[0].errorCode, "SMTP_ERROR");
});

test("coalesces many blocked requests into minute buckets without storing recipients", async () => {
  const collection = new FakeEvents();
  const now = () => Date.UTC(2026, 9, 31, 12, 20, 42);
  for (let i = 0; i < 1000; i++) {
    await recordRegistrationEmailEvent({ collection, eventType: "rate_limited", flow: "request_otp", recipient: `user${i}@example.test`, now });
  }
  assert.equal(collection.records.length, 1);
  assert.equal(collection.records[0].count, 1000);
  assert.equal(collection.records[0].recipientMasked, undefined);
});

test("report uses Philippine calendar dates even across UTC midnight", async () => {
  const collection = new FakeEvents();
  const a = Date.UTC(2026, 9, 30, 16, 2); // 00:02 October 31 in Manila
  const b = Date.UTC(2026, 9, 31, 15, 58); // 23:58 October 31 in Manila
  const c = Date.UTC(2026, 9, 31, 16, 2); // 00:02 November 1 in Manila
  for (const time of [a, b, c]) await recordRegistrationEmailEvent({ collection, eventType: "reserved", recipient: "a@example.test", now: () => time });
  await recordRegistrationEmailEvent({ collection, eventType: "smtp_accepted", recipient: "a@example.test", now: () => b });
  const report = await getEmailMonitoringReport({ collection, params: { from: "2026-10-31", to: "2026-10-31" } });
  assert.equal(report.summary.attempted, 2);
  assert.equal(report.summary.accepted, 1);
  assert.equal(report.history.totalRecords, 3);
  assert.equal(report.daily[0].date, "2026-10-31");
  assert.equal(report.providerDeliveryVerified, false);
});

test("report paginates and filters history but retains unfiltered period totals", async () => {
  const collection = new FakeEvents();
  const now = () => Date.UTC(2026, 9, 31, 0);
  for (let i = 0; i < 30; i++) await recordRegistrationEmailEvent({ collection, eventType: "reserved", recipient: "a@example.test", now });
  await recordRegistrationEmailEvent({ collection, eventType: "smtp_accepted", recipient: "a@example.test", now });
  const report = await getEmailMonitoringReport({ collection, params: { from: "2026-10-31", to: "2026-10-31", type: "reserved", page: 2, limit: 10 } });
  assert.equal(report.summary.attempted, 30);
  assert.equal(report.summary.accepted, 1);
  assert.equal(report.history.rows.length, 10);
  assert.equal(report.history.page, 2);
  assert.equal(report.history.totalPages, 3);
  assert.equal(report.history.totalRecords, 30);
});

test("rate-limit count aggregates repeated hits, not only MongoDB documents", async () => {
  const collection = new FakeEvents();
  const now = () => Date.UTC(2026, 9, 31);
  for (let i = 0; i < 75; i++) await recordRegistrationEmailEvent({ collection, eventType: "rate_limited", now });
  const report = await getEmailMonitoringReport({ collection, params: { from: "2026-10-31", to: "2026-10-31" } });
  assert.equal(report.summary.rateLimited, 75);
  assert.equal(report.history.totalRecords, 1);
  assert.equal(report.history.rows[0].count, 75);
});

test("rejects invalid dates, excessive date windows, invalid event types and oversized pagination", () => {
  for (const date of ["2026-02-30", "2026-10-99", "31-10-2026", "2026-10-31T10:00:00"]) {
    assert.throws(() => parseReportRange({ from: date, to: date }), /valid dates/);
  }
  assert.throws(() => parseReportRange({ from: "2026-01-01", to: "2026-12-31" }), /maximum 93 days/);
  assert.throws(() => parseHistoryOptions({ from: "2026-10-31", to: "2026-10-31", page: "1001" }), /Invalid pagination/);
  assert.throws(() => parseHistoryOptions({ from: "2026-10-31", to: "2026-10-31", type: "DROP_TABLE" }), /Invalid email event filter/);
});

test("distinguishes definite SMTP rejection from ambiguous timeout", () => {
  assert.equal(classifySmtpFailure({ responseCode: 550, code: "EENVELOPE" }), "smtp_rejected");
  assert.equal(classifySmtpFailure({ code: "SMTP_REJECTED" }), "smtp_rejected");
  assert.equal(classifySmtpFailure({ code: "ETIMEDOUT" }), "smtp_unconfirmed");
  assert.equal(classifySmtpFailure({ responseCode: 421 }), "smtp_unconfirmed");
});

test("CSV output is escaped and never contains raw email addresses", () => {
  const csv = csvRecord({ createdAt: new Date("2026-10-31T00:00:00Z"), eventType: "smtp_accepted", flow: "request_otp", recipientMasked: "j***@g***.com", count: 1 });
  assert.match(csv, /j\*\*\*@g\*\*\*\.com/);
  assert.doesNotMatch(csv, /jane@example\.com/);
  const spreadsheetFormula = csvRecord({ createdAt: new Date("2026-10-31T00:00:00Z"), eventType: "=HYPERLINK", flow: "request_otp" });
  assert.match(spreadsheetFormula, /'=HYPERLINK/);
});

test("admin monitoring routes require reports:view, no mutation or email-sending endpoint", () => {
  const routes = source("routes/adminRoutes.js");
  assert.match(routes, /router\.use\(authMiddleware_js_1\.protect, authMiddleware_js_1\.adminOnly\)/);
  assert.match(routes, /"\/email-monitoring",\s*\(0, authMiddleware_js_1\.requirePermission\)\("reports", "view"\)/);
  assert.match(routes, /"\/email-monitoring\/export",\s*\(0, authMiddleware_js_1\.requirePermission\)\("reports", "view"\)/);
  const controller = source("controllers/emailMonitoringController.js");
  assert.doesNotMatch(controller, /SMTP_PASS|sendMail\(|sendRegistrationOtpEmail\(|req\.body/);
  assert.match(controller, /Content-Disposition/);
});

test("registration OTP controller records reservation, accepted and failed paths; no extra email senders", () => {
  const auth = source("controllers/authController.js");
  assert.equal((auth.match(/sendRegistrationOtpEmail\)\(/g) || []).length, 2);
  assert.equal((auth.match(/eventType: "smtp_accepted"/g) || []).length, 2);
  assert.match(auth, /eventType: "rate_limited"/);
  assert.match(auth, /emailHistory\.classifySmtpFailure/);
  assert.match(auth, /eventType: "reserved"/);
  assert.doesNotMatch(source("controllers/bookingController.js"), /sendRegistrationOtpEmail|sendMail\(/);
});

test("history totals have separate definite rejection and unconfirmed categories", () => {
  const { summary } = summarizeBuckets([
    { _id: { eventType: "smtp_rejected", date: "2026-10-31" }, count: 2 },
    { _id: { eventType: "smtp_unconfirmed", date: "2026-10-31" }, count: 3 },
    { _id: { eventType: "reserved", date: "2026-10-31" }, count: 10 },
  ]);
  assert.equal(summary.rejected, 2);
  assert.equal(summary.unconfirmed, 3);
  assert.equal(summary.attempted, 10);
});

test("regression: admin's exact type=all query and CSV filter are supported", async () => {
  const query = Object.fromEntries(new URLSearchParams("from=2026-10-31&to=2026-10-31&type=all&page=1&limit=25"));
  assert.equal(parseHistoryOptions(query).type, "all");
  assert.equal(parseHistoryOptions({ ...query, type: " ALL " }).type, "all");
  assert.equal(parseHistoryOptions({ ...query, type: "" }).type, "all");
  assert.equal(parseHistoryOptions({ ...query, type: "smtp_accepted" }).type, "smtp_accepted");
  assert.equal(parseHistoryOptions({ from: query.from, to: query.to }).type, "all");
  assert.throws(() => parseHistoryOptions({ ...query, type: ["all"] }), /Invalid email event filter/);

  const collection = new FakeEvents();
  const now = () => Date.parse("2026-10-31T06:00:00.000Z");
  await recordRegistrationEmailEvent({ collection, eventType: "reserved", recipient: "x@example.test", now });
  await recordRegistrationEmailEvent({ collection, eventType: "smtp_accepted", recipient: "x@example.test", now });
  const all = await getEmailMonitoringReport({ collection, params: query });
  assert.equal(all.summary.attempted, 1);
  assert.equal(all.summary.accepted, 1);
  assert.equal(all.history.totalRecords, 2);
  const accepted = await getEmailMonitoringReport({ collection, params: { ...query, type: "smtp_accepted" } });
  assert.equal(accepted.history.totalRecords, 1);
  // Both summary cards stay unfiltered, as designed.
  assert.equal(accepted.summary.attempted, 1);
});
