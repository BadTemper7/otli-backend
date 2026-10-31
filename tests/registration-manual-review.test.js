"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
    reserveRegistrationEmailSlot,
    getRegistrationEmailStatus,
    inspectRegistrationEmailLimit,
} = require("../utils/registrationEmailLimit.js");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const legal = { termsAccepted: true, privacyAccepted: true, representativeAuthorityConfirmed: true, acceptedAt: new Date() };
const fields = ["businessPermit", "birCertificate", "validId"];
const uploadedFiles = () => Object.fromEntries(fields.map((name) => [name, [{ originalname: name + ".pdf", mimetype: "application/pdf", size: 128 }]]));
const registrationBody = () => ({
    companyName: "Acme Trucking", companyAddress: "Manila", companyType: "trucking", companyTypeOther: "",
    phoneNumber: "09000000000", representativeFirstName: "Jane", representativeLastName: "Doe",
    representativePosition: "owner", email: "jane@example.test", password: "a-strong-test-password",
    confirmPassword: "a-strong-test-password", termsAccepted: "true", privacyAccepted: "true", representativeAuthorityConfirmed: "true",
});
const reply = () => ({ statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } });
const load = (source, modules) => {
    const sandbox = {
        exports: {},
        require: (name) => modules[name] || {},
        process: { env: { EMAIL_OTP_RESEND_SECONDS: "60" } },
        console: { warn() {}, info() {} }, Date, Object, String, Array, Number, Set, Math,
    };
    vm.runInNewContext(read(source), sandbox, { timeout: 1500, filename: source });
    return sandbox.exports;
};
const mockAuth = () => {
    let sent = 0;
    let created;
    let documents = [];
    const modules = {
        bcryptjs: { hash: async () => "hashed" },
        mongoose: { Types: { ObjectId: class { toString() { return "newId"; } } } },
        "../models/User.js": {
            findOne: async () => null,
            exists: async () => false,
            create: async (payload) => { created = payload; return { ...payload, createdAt: new Date() }; },
        },
        "../models/PendingClient.js": { findOne: async () => null },
        "../utils/localFileStorage.js": {
            saveUploadedFile: async ({ prefix }) => {
                documents.push(prefix);
                return { url: `/documents/${prefix}`, secureUrl: `/documents/${prefix}`, publicId: prefix, resourceType: "local" };
            },
            deleteLocalFile: async () => true,
        },
        "../config/mailer.js": { sendRegistrationOtpEmail: async () => { sent++; } },
        "../utils/registrationEmailHistory.js": { recordEmailEventSafely() {}, classifySmtpFailure: () => "smtp_unconfirmed" },
        "../utils/registrationEmailLimit.js": {
            getRegistrationEmailStatus: async () => ({ allowed: false, retryAfterSeconds: 3600, limitName: "hour" }),
            reserveRegistrationEmailSlot: async () => { throw Object.assign(new Error("Limited"), { code: "REGISTRATION_EMAIL_LIMIT", retryAfterSeconds: 3600 }); },
        },
        "../utils/generateOtp.js": { generateOtp: () => "123456", hashOtp: async () => "hash" },
        "../utils/jwt.js": { generateToken: () => "test-token" },
        "../utils/emailTemplates.js": { otpEmailTemplate: () => "<p>OTP</p>" },
        "../socket/socket.js": { emitToAdmins() {} },
        "../utils/permissions.js": { normalizePermissions: () => ({}) },
        "../utils/legalPolicies.js": { TERMS_VERSION: "1", PRIVACY_POLICY_VERSION: "1" },
        "../utils/notificationService.js": {},
    };
    const controller = load("controllers/authController.js", modules);
    return { controller, metrics: () => ({ sent, created, documents }) };
};

test("status probe reports exact retry time without reserving or sending", async () => {
    const collection = { findOne: async () => ({ reservations: [new Date(10000)] }) };
    const status = await getRegistrationEmailStatus({ collection, now: () => 11000 });
    assert.equal(status.allowed, false);
    assert.equal(status.retryAfterSeconds, 11);
    assert.equal(status.limitName, "spacing");
    const noLimit = await getRegistrationEmailStatus({ collection, now: () => 23000 });
    assert.equal(noLimit.allowed, true);
    assert.equal(noLimit.retryAfterSeconds, 0);
});

test("24-hour quota calculates a real retryAfter, without raising provider quota", () => {
    const start = 10_000_000;
    const reservations = Array.from({ length: 100 }, (_, i) => new Date(start + 80_000 * i));
    const result = inspectRegistrationEmailLimit(reservations, start + 8_000_000);
    assert.equal(result.allowed, false);
    assert.equal(result.limitName, "day");
    assert.equal(result.retryAfterSeconds, Math.ceil((start + 86_400_000 - (start + 8_000_000)) / 1000));
});

test("manual review registers pending client, leaves email unverified, and sends zero emails", async () => {
    const { controller, metrics } = mockAuth();
    const res = reply();
    await controller.submitClientManualRegistration({ body: registrationBody(), files: uploadedFiles(), headers: {} }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.user.isEmailVerified, false);
    assert.equal(res.body.user.registrationMethod, "manual_review");
    assert.equal(metrics().created.status, "pending");
    assert.equal(metrics().created.userType, "client");
    assert.equal(metrics().sent, 0);
    assert.deepEqual(metrics().documents.sort(), fields.sort());
});

test("manual review rejects missing documents without creating accounts or sending mail", async () => {
    const { controller, metrics } = mockAuth();
    const res = reply();
    await controller.submitClientManualRegistration({ body: registrationBody(), files: {}, headers: {} }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(metrics().created, undefined);
    assert.equal(metrics().sent, 0);
});

test("registration quota API returns Retry-After and manual review option", async () => {
    const { controller } = mockAuth();
    const res = reply();
    await controller.checkRegistrationEmailAvailability({}, res);
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers["Retry-After"], "3600");
    assert.equal(res.body.manualReviewAvailable, true);
    assert.equal(res.body.code, "REGISTRATION_EMAIL_LIMIT");
});

test("admin Add Client is permission-gated, pending, unverified, and sends no email", async () => {
    const routes = read("routes/adminRoutes.js");
    assert.match(routes, /"\/clients",[\s\S]{0,110}requirePermission\)\("clientVerification", "create"\)/);
    let payload;
    const controller = load("controllers/adminController.js", {
        "../models/User.js": {
            exists: async () => false,
            create: async (data) => { payload = data; return { ...data, createdAt: new Date() }; },
        },
        "../models/PendingClient.js": { findOne: async () => null },
        mongoose: { Types: { ObjectId: class { toString() { return "admin-client-id"; } } } },
        "../utils/localFileStorage.js": { deleteLocalFile: async () => true },
        "./authController.js": {
            uploadRegistrationDocuments: async () => fields.map((type) => ({ type, publicId: type, label: type, url: "/documents/" + type })),
            safeUser: (data) => ({ ...data, password: undefined }),
        },
        "../socket/socket.js": { emitToAdmins() {} },
        "../utils/permissions.js": {},
        "../utils/notificationService.js": {},
    });
    const res = reply();
    await controller.createClient({
        body: registrationBody(), files: uploadedFiles(), user: { _id: "adminId" },
    }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(payload.status, "pending");
    assert.equal(payload.isEmailVerified, false);
    assert.equal(payload.registrationMethod, "admin");
    assert.equal(res.body.user.password, undefined);
});

test("manual accounts require explicit administrator confirmation before approval", async () => {
    let saved = 0;
    const user = {
        _id: "id", status: "pending", userType: "client", isEmailVerified: false,
        registrationMethod: "manual_review",
        documents: fields.map((type) => ({ type })),
        async save() { saved++; },
    };
    const controller = load("controllers/adminController.js", {
        "../models/User.js": { findById: async () => user },
        "../models/PendingClient.js": {},
        mongoose: {},
        "../utils/localFileStorage.js": {},
        "./authController.js": { safeUser: (data) => ({ ...data }) },
        "../socket/socket.js": { emitToAdmins() {}, emitToUser() {} },
        "../utils/permissions.js": {},
        "../utils/notificationService.js": { createClientNotification: async () => {} },
    });
    const first = reply();
    await controller.approveClient({ params: { id: "id" }, body: {}, user: { _id: "staffId" } }, first);
    assert.equal(first.statusCode, 400);
    assert.equal(saved, 0);
    const second = reply();
    await controller.approveClient({ params: { id: "id" }, body: { confirmManualVerification: true }, user: { _id: "staffId" } }, second);
    assert.equal(second.statusCode, 200);
    assert.equal(saved, 1);
    assert.equal(user.status, "verified");
    assert.equal(user.isEmailVerified, false);
    assert.equal(user.manuallyVerifiedBy, "staffId");
});
