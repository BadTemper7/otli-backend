"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
    reserveRegistrationEmailSlot,
    WINDOW_LIMITS,
} = require("../utils/registrationEmailLimit.js");

// Atomic MongoDB behavior is mocked here: no real SMTP traffic or DB writes.
class MockCollection {
    doc = null;
    async findOne() {
        if (!this.doc) return null;
        return {
            ...this.doc,
            reservations: this.doc.reservations.map((stamp) => new Date(stamp)),
        };
    }
    async insertOne(doc) {
        if (this.doc) throw Object.assign(new Error("duplicate _id"), { code: 11000 });
        this.doc = { ...doc };
        return { insertedId: doc._id };
    }
    async updateOne(filter, update) {
        if (!this.doc || this.doc._id !== filter._id || this.doc.version !== filter.version)
            return { matchedCount: 0 };
        this.doc = {
            ...this.doc,
            ...update.$set,
            version: this.doc.version + update.$inc.version,
        };
        return { matchedCount: 1 };
    }
}

function file(relativePath) {
    return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

function loadModuleWithMocks(source, mocks = {}) {
    const exports = {};
    const sandbox = {
        exports,
        require: (moduleName) => mocks[moduleName] || {},
        process: { env: { NODE_ENV: "production", SMTP_HOST: "fake.local", SMTP_USER: "noreply@example.test", SMTP_PASS: "hidden" } },
        console: { info: () => {}, log: () => {} },
        Date,
        String,
        Object,
        Array,
    };
    vm.runInNewContext(source, sandbox, { timeout: 1000 });
    return sandbox.exports;
}

test("registration limit: first send allowed; rapid repeat blocked", async () => {
    const collection = new MockCollection();
    await reserveRegistrationEmailSlot({ collection, now: () => 10_000_000 });
    await assert.rejects(
        reserveRegistrationEmailSlot({ collection, now: () => 10_000_001 }),
        (e) => e.code === "REGISTRATION_EMAIL_LIMIT" && e.statusCode === 429,
    );
    assert.equal(collection.doc.reservations.length, 1);
});

test("registration limit: 1,000 simultaneous attempts allow only one", async () => {
    const collection = new MockCollection();
    const results = await Promise.allSettled(Array.from({ length: 1000 }, () =>
        reserveRegistrationEmailSlot({ collection, now: () => 10_000_000 }),
    ));
    assert.equal(results.filter((v) => v.status === "fulfilled").length, 1);
    assert.equal(results.filter((v) => v.status === "rejected").length, 999);
    assert.equal(collection.doc.reservations.length, 1);
});

test("registration limit: 12-second spacing and rolling minute quota", async () => {
    const collection = new MockCollection();
    const origin = 10_000_000;
    for (let i = 0; i < 5; i++) {
        await reserveRegistrationEmailSlot({ collection, now: () => origin + i * 12_000 });
    }
    await assert.rejects(
        reserveRegistrationEmailSlot({ collection, now: () => origin + 55_000 }),
        (e) => e.code === "REGISTRATION_EMAIL_LIMIT",
    );
    // At exactly 60 seconds the first reservation falls outside the window.
    await reserveRegistrationEmailSlot({ collection, now: () => origin + 60_000 });
});

test("registration limit: rolling hour cap of 50", async () => {
    const collection = new MockCollection();
    const origin = 10_000_000;
    for (let i = 0; i < 50; i++) {
        await reserveRegistrationEmailSlot({ collection, now: () => origin + i * 12_000 });
    }
    await assert.rejects(
        reserveRegistrationEmailSlot({ collection, now: () => origin + 700_000 }),
        (e) => e.code === "REGISTRATION_EMAIL_LIMIT",
    );
    await reserveRegistrationEmailSlot({ collection, now: () => origin + 3_600_000 });
});

test("registration limit: rolling 24-hour cap of 100", async () => {
    const collection = new MockCollection();
    const origin = 10_000_000;
    for (let i = 0; i < 100; i++) {
        await reserveRegistrationEmailSlot({ collection, now: () => origin + i * 80_000 });
    }
    await assert.rejects(
        reserveRegistrationEmailSlot({ collection, now: () => origin + 8_000_000 }),
        (e) => e.code === "REGISTRATION_EMAIL_LIMIT",
    );
    await reserveRegistrationEmailSlot({ collection, now: () => origin + 86_400_000 });
});

test("registration limit: a stale CAS version cannot reserve an extra send", async () => {
    const collection = new MockCollection();
    await reserveRegistrationEmailSlot({ collection, now: () => 10_000_000 });
    const version = collection.doc.version;
    const badUpdate = await collection.updateOne(
        { _id: "registration-otp-smtp", version: version - 1 },
        { $set: { reservations: [new Date(123)] }, $inc: { version: 1 } },
    );
    assert.equal(badUpdate.matchedCount, 0);
    assert.equal(collection.doc.reservations.length, 1);
});

test("registration limit: no email address or OTP is stored", async () => {
    const collection = new MockCollection();
    await reserveRegistrationEmailSlot({ collection, now: () => 10_000_000 });
    assert.deepEqual(Object.keys(collection.doc).sort(), ["_id", "reservations", "updatedAt", "version"].sort());
    assert.equal(WINDOW_LIMITS.length, 4);
});

test("email source: booking notifications stay in-app, with no SMTP", () => {
    const booking = file("controllers/bookingController.js");
    assert.match(booking, /createClientNotification/);
    assert.match(booking, /emitToAdmins/);
    assert.doesNotMatch(booking, /mailer_js_1|notifyEmail|notifyAdmin|sendRegistrationOtpEmail/);
});

test("email source: only two registration code paths send SMTP", () => {
    const auth = file("controllers/authController.js");
    const booking = file("controllers/bookingController.js");
    assert.equal((auth.match(/sendRegistrationOtpEmail\)\(/g) || []).length, 2);
    assert.equal((auth.match(/allowRegistrationOtpEmail\(res\)/g) || []).length, 2);
    assert.match(auth, /canResendOtp\(pending\.otpLastSentAt\)/);
    assert.doesNotMatch(booking, /sendRegistrationOtpEmail/);
});

test("forgot/reset/test endpoints return 410 without triggering email", async () => {
    const controller = loadModuleWithMocks(file("controllers/authController.js"));
    for (const name of ["forgotPassword", "resetPassword", "sendTestEmail"]) {
        let code;
        let response;
        const res = { status(status) { code = status; return this; }, json(body) { response = body; return this; } };
        await controller[name]({ body: { email: "alice@example.test" } }, res);
        assert.equal(code, 410, name);
        assert.equal(response.success, false, name);
    }
});

test("registration-only mailer rejects missing email content and uses a fixed subject", async () => {
    let sent = [];
    const fakeTransport = {
        sendMail: async (mail) => {
            sent.push(mail);
            return { accepted: [mail.to], rejected: [] };
        },
        verify: async () => true,
    };
    const mailer = loadModuleWithMocks(file("config/mailer.js"), {
        nodemailer: { createTransport: () => fakeTransport },
    });
    assert.equal(mailer.sendEmail, undefined);
    await assert.rejects(mailer.sendRegistrationOtpEmail({ to: "not-an-email", html: "OTP" }));
    await mailer.sendRegistrationOtpEmail({ to: "alice@example.test", html: "<p>123456</p>" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, "OTLI Client Registration OTP");
});

test("registration limit: MongoDB disconnection fails closed", async () => {
    const collection = {
        async findOne() { throw new Error("MongoDB temporarily unavailable"); },
    };
    await assert.rejects(
        reserveRegistrationEmailSlot({ collection, now: () => 10_000_000 }),
        /MongoDB temporarily unavailable/,
    );
});

test("registration mailer: rejects SMTP non-acceptance without retrying", async () => {
    let attempts = 0;
    const mailer = loadModuleWithMocks(file("config/mailer.js"), {
        nodemailer: {
            createTransport: () => ({
                sendMail: async () => { attempts += 1; return { accepted: [], rejected: ["alice@example.test"] }; },
                verify: async () => true,
            }),
        },
    });
    await assert.rejects(
        mailer.sendRegistrationOtpEmail({ to: "alice@example.test", html: "OTP" }),
        /was not accepted/,
    );
    assert.equal(attempts, 1);
});
