"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
    reserveRegistrationEmailSlot,
    startRegistrationEmailSend,
    finishRegistrationEmailSend,
    releaseUnstartedRegistrationEmailSlot,
    reconcileUnusedRegistrationEmailSlots,
    getRegistrationEmailUsage,
    UNUSED_GRACE_MS,
} = require("../utils/registrationEmailLimit.js");

class Collection {
    doc = null;
    async findOne() { return this.doc ? structuredClone(this.doc) : null; }
    async insertOne(value) {
        if (this.doc) throw Object.assign(new Error("duplicate"), { code: 11000 });
        this.doc = structuredClone(value);
        return { insertedId: value._id };
    }
    async updateOne(where, changes) {
        if (!this.doc || where.version !== this.doc.version) return { matchedCount: 0 };
        this.doc = { ...this.doc, ...structuredClone(changes.$set), version: this.doc.version + changes.$inc.version };
        return { matchedCount: 1 };
    }
}

const origin = Date.parse("2026-10-31T00:00:00Z");
test("unused reserved before SMTP can be released instantly after a local failure", async () => {
    const store = new Collection();
    const token = await reserveRegistrationEmailSlot({ collection: store, now: () => origin });
    assert.equal(store.doc.reservations.length, 1);
    assert.equal(store.doc.reservationStages[token], "unused");
    assert.equal(await releaseUnstartedRegistrationEmailSlot({ token, collection: store }), true);
    assert.equal(store.doc.reservations.length, 0);
    assert.equal(await releaseUnstartedRegistrationEmailSlot({ token, collection: store }), false);
});

test("super admin cleanup releases only abandoned, still-unused reservations after grace period", async () => {
    const store = new Collection();
    const token = await reserveRegistrationEmailSlot({ collection: store, now: () => origin });
    const tooEarly = await reconcileUnusedRegistrationEmailSlots({ collection: store, now: () => origin + UNUSED_GRACE_MS - 1 });
    assert.equal(tooEarly.released, 0);
    const available = await getRegistrationEmailUsage({ collection: store, now: () => origin + UNUSED_GRACE_MS });
    assert.equal(available.reclaimableUnused, 1);
    const result = await reconcileUnusedRegistrationEmailSlots({ collection: store, now: () => origin + UNUSED_GRACE_MS });
    assert.equal(result.released, 1);
    assert.equal(result.remaining, 0);
    await assert.rejects(startRegistrationEmailSend({ collection: store, token }), /no longer available/);
});

test("an SMTP-started send cannot be released even when old", async () => {
    const store = new Collection();
    const token = await reserveRegistrationEmailSlot({ collection: store, now: () => origin });
    await startRegistrationEmailSend({ collection: store, token });
    assert.equal(await releaseUnstartedRegistrationEmailSlot({ collection: store, token }), false);
    const result = await reconcileUnusedRegistrationEmailSlots({ collection: store, now: () => origin + 60 * 60 * 1000 });
    assert.equal(result.released, 0);
    assert.equal(result.remaining, 1);
    await finishRegistrationEmailSend({ collection: store, token, outcome: "smtp_unconfirmed" });
    const remaining = await getRegistrationEmailUsage({ collection: store, now: () => origin + 60 * 60 * 1000 });
    assert.equal(remaining.windows.day.used, 1);
});

test("accepted and rejected SMTP attempts are never automatically reclaimed", async () => {
    const store = new Collection();
    const token1 = await reserveRegistrationEmailSlot({ collection: store, now: () => origin });
    await startRegistrationEmailSend({ collection: store, token: token1 });
    await finishRegistrationEmailSend({ collection: store, token: token1, outcome: "smtp_accepted" });
    const token2 = await reserveRegistrationEmailSlot({ collection: store, now: () => origin + 60_000 });
    await startRegistrationEmailSend({ collection: store, token: token2 });
    await finishRegistrationEmailSend({ collection: store, token: token2, outcome: "smtp_rejected" });
    const result = await reconcileUnusedRegistrationEmailSlots({ collection: store, now: () => origin + 60 * 60 * 1000 });
    assert.equal(result.released, 0);
    assert.equal(result.remaining, 2);
    assert.equal(await releaseUnstartedRegistrationEmailSlot({ collection: store, token: token1 }), false);
});

test("older unclassified 100-slot reservations cannot be wiped to get around a provider limit", async () => {
    const store = new Collection();
    store.doc = {
        _id: "registration-otp-smtp", version: 101,
        reservations: Array.from({ length: 100 }, (_, i) => new Date(origin + i * 70_000)),
        updatedAt: new Date(origin + 99 * 70_000),
    };
    const result = await reconcileUnusedRegistrationEmailSlots({ collection: store, now: () => origin + 8_000_000 });
    assert.equal(result.released, 0);
    assert.equal(result.legacyHeld, 100);
    const usage = await getRegistrationEmailUsage({ collection: store, now: () => origin + 8_000_000 });
    assert.equal(usage.windows.day.remaining, 0);
    assert.equal(usage.unclassifiedReservations, 100);
});

test("concurrent admin cleanup and SMTP handoff cannot both succeed", async () => {
    const store = new Collection();
    const token = await reserveRegistrationEmailSlot({ collection: store, now: () => origin });
    const results = await Promise.allSettled([
        startRegistrationEmailSend({ collection: store, token }),
        reconcileUnusedRegistrationEmailSlots({ collection: store, now: () => origin + UNUSED_GRACE_MS }),
    ]);
    const usage = await getRegistrationEmailUsage({ collection: store, now: () => origin + UNUSED_GRACE_MS });
    const beganSmtp = store.doc.reservationStages?.[token] === "smtp_started";
    assert.equal(usage.windows.day.used, beganSmtp ? 1 : 0);
    assert.ok(results.some((item) => item.status === "fulfilled"));
    if (beganSmtp) assert.equal(usage.reclaimableUnused, 0);
});

test("maintenance endpoint is Super Admin only and no arbitrary slot reset is exposed", () => {
    const root = path.join(__dirname, "..");
    const routes = fs.readFileSync(path.join(root, "routes/adminRoutes.js"), "utf8");
    const controller = fs.readFileSync(path.join(root, "controllers/emailUsageController.js"), "utf8");
    const auth = fs.readFileSync(path.join(root, "controllers/authController.js"), "utf8");
    assert.match(routes, /"\/email-usage\/reconcile",\s*authMiddleware_js_1\.superAdminOnly/);
    assert.match(controller, /reconcileUnusedRegistrationEmailSlots\(\)/);
    assert.doesNotMatch(controller, /sendRegistrationOtpEmail\(|clearAll|\$unset.*reservations/);
    assert.ok(auth.indexOf("saveFilesMs") < auth.indexOf("allowRegistrationOtpEmail(res, { recipient: normalizedEmail, flow: \"request_otp\""));
});

test("public registration always permits manual review and does not rely on quota check for it", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../client/src/pages/Register.jsx"), "utf8");
    assert.match(src, /currentStep === 4 && \(/);
    assert.match(src, /Submit for Manual Review \(No OTP\)/);
    assert.match(src, /"\/auth\/client\/register\/manual-review"/);
});
