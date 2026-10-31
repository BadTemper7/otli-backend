"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const EventEmitter = require("node:events");
const timings = require("../utils/registrationTiming.js");

const projectFile = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");

function makeResponse() {
    return {
        statusCode: 200,
        headers: {},
        status(value) { this.statusCode = value; return this; },
        set(name, value) { this.headers[name] = value; return this; },
        json(value) { this.body = value; return this; },
    };
}

function makeController({ smtpFails = false, fileFails = false } = {}) {
    let maxActiveWrites = 0;
    let activeWrites = 0;
    let sendCalls = 0;
    let reservedSlots = 0;
    let pendingWrites = 0;
    let deletedFiles = 0;
    const legal = { termsAccepted: true, privacyAccepted: true, representativeAuthorityConfirmed: true, acceptedAt: new Date() };
    const pending = { legalConsent: legal, otpLastSentAt: new Date(Date.now() - 120000), save: async () => {} };

    const mockModules = {
        bcryptjs: { hash: async () => "hash" },
        mongoose: { Types: { ObjectId: class { toString() { return "123"; } } } },
        "../models/User.js": { findOne: async () => null },
        "../models/PendingClient.js": {
            findOne: () => ({ select: async () => null }),
            findOneAndUpdate: async () => { pendingWrites++; },
        },
        "../utils/localFileStorage.js": {
            saveUploadedFile: async ({ prefix }) => {
                activeWrites++;
                maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
                await new Promise((resolve) => setTimeout(resolve, 3));
                activeWrites--;
                if (fileFails && prefix === "validId") throw new Error("simulated disk error");
                return { url: `/documents/${prefix}`, secureUrl: `/documents/${prefix}`, publicId: prefix, resourceType: "local" };
            },
            deleteLocalFile: async () => { deletedFiles++; },
        },
        "../config/mailer.js": { sendRegistrationOtpEmail: async () => {
            sendCalls++;
            if (smtpFails) throw Object.assign(new Error("socket timeout (test)"), { code: "ETIMEDOUT" });
            return { acceptedByProvider: true };
        } },
        "../utils/registrationEmailHistory.js": { recordEmailEventSafely() {}, classifySmtpFailure: () => "smtp_unconfirmed" },
        "../utils/registrationEmailLimit.js": { reserveRegistrationEmailSlot: async () => { reservedSlots++; return true; } },
        "../utils/registrationTiming.js": timings,
        "../utils/generateOtp.js": { generateOtp: () => "123456", hashOtp: async () => "otpHash" },
        "../utils/jwt.js": {},
        "../utils/emailTemplates.js": { otpEmailTemplate: () => "<p>OTP</p>" },
        "../socket/socket.js": {},
        "../utils/permissions.js": {},
        "../utils/legalPolicies.js": { TERMS_VERSION: "1", PRIVACY_POLICY_VERSION: "1" },
        "../utils/notificationService.js": {},
    };
    const sandbox = {
        exports: {},
        require: (moduleName) => mockModules[moduleName] || {},
        process: { env: { EMAIL_OTP_RESEND_SECONDS: "60" } },
        console: { warn: () => {}, info: () => {} },
        Date, String, Array, Object, Math, Set,
    };
    vm.runInNewContext(projectFile("controllers/authController.js"), sandbox, { timeout: 500 });
    return {
        controller: sandbox.exports,
        metrics: () => ({ maxActiveWrites, activeWrites, sendCalls, reservedSlots, pendingWrites, deletedFiles }),
    };
}

function registrationRequest() {
    const fields = ["businessPermit", "birCertificate", "validId"];
    return {
        body: {
            companyName: "Company", companyAddress: "Address", companyType: "corporation",
            phoneNumber: "123", representativeFirstName: "Test", representativeLastName: "User",
            representativePosition: "Owner", email: "test@example.test", password: "safe-test-password",
            confirmPassword: "safe-test-password", termsAccepted: "true", privacyAccepted: "true",
            representativeAuthorityConfirmed: "true",
        },
        files: Object.fromEntries(fields.map((name) => [name, [{ originalname: name + ".pdf", mimetype: "application/pdf", size: 42 }]])),
        headers: {},
    };
}

test("request-otp persists registration before SMTP and saves documents concurrently", async () => {
    const { controller, metrics } = makeController();
    const res = makeResponse();
    await controller.requestClientRegistrationOtp(registrationRequest(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(metrics().pendingWrites, 1);
    assert.equal(metrics().sendCalls, 1);
    assert.ok(metrics().maxActiveWrites >= 2, "registration files should not be saved serially");
});

test("SMTP timeout returns 503 with retry guidance and does not send twice", async () => {
    const { controller, metrics } = makeController({ smtpFails: true });
    const res = makeResponse();
    await controller.requestClientRegistrationOtp(registrationRequest(), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, "REGISTRATION_OTP_DELIVERY_UNCONFIRMED");
    assert.equal(res.headers["Retry-After"], "60");
    assert.equal(metrics().sendCalls, 1);
    assert.equal(metrics().pendingWrites, 1);
});

test("document failure cleans up successful writes before SMTP", async () => {
    const { controller, metrics } = makeController({ fileFails: true });
    await assert.rejects(controller.requestClientRegistrationOtp(registrationRequest(), makeResponse()), /simulated disk error/);
    assert.equal(metrics().deletedFiles, 2);
    assert.equal(metrics().sendCalls, 0);
    assert.equal(metrics().pendingWrites, 0);
});

test("registration timing middleware records multipart upload and steps without PII", async () => {
    const req = {};
    const res = new EventEmitter();
    res.statusCode = 200;
    res.writableEnded = true;
    timings.watchRegistrationRequest("request-otp")(req, res, () => {});
    timings.markRegistrationUploadComplete(req, res, () => {});
    assert.ok(req.registrationTiming.stages.uploadMs >= 0);
    const result = await timings.timeRegistrationStage(req, "smtpMs", async () => 42);
    assert.equal(result, 42);
    assert.ok(req.registrationTiming.stages.smtpMs >= 0);
    assert.equal(JSON.stringify(req.registrationTiming).includes("example.test"), false);
    res.emit("finish");
});

test("SMTP transport uses bounded idle timeouts instead of the original 30s socket timeout", () => {
    let options;
    const sandbox = {
        exports: {},
        require: () => ({ createTransport: (o) => { options = o; return {}; } }),
        process: { env: { SMTP_HOST: "smtp.example.test", SMTP_PORT: "465", SMTP_USER: "mailer@example.test", SMTP_PASS: "not-a-real-secret" } },
        console: { info: () => {} },
        Date, String, Number, Array, Object,
    };
    vm.runInNewContext(projectFile("config/mailer.js"), sandbox);
    sandbox.exports.getTransporter();
    assert.equal(options.connectionTimeout, 8000);
    assert.equal(options.greetingTimeout, 8000);
    assert.equal(options.socketTimeout, 12000);
});
