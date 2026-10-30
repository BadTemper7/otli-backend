"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");
const booking = fs.readFileSync(path.join(root, "controllers", "bookingController.js"), "utf8");
const auth = fs.readFileSync(path.join(root, "controllers", "authController.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

test("booking notifications remain in-app without outgoing email calls", () => {
    assert.ok(booking.includes("createClientNotification"));
    assert.equal(booking.includes("config/mailer"), false);
    assert.equal(booking.includes("sendMail"), false);
    assert.equal(booking.includes("notifyEmail"), false);
    assert.equal(booking.includes("notifyAdmin"), false);
});

test("only registration OTP paths may call the SMTP sending helper", () => {
    assert.equal((auth.match(/mailer_js_1\.sendRegistrationOtp/g) || []).length, 2);
    assert.equal(auth.includes("mailer_js_1.sendEmail"), false);
    assert.ok(auth.includes("Email password reset is disabled"));
    assert.ok(auth.includes("Test emails are disabled"));
    assert.ok(server.includes('err?.code === "REGISTRATION_EMAIL_RATE_LIMIT"'));
});

// Stub Nodemailer and the limiter before loading the actual SMTP module; no
// external dependencies or real emails are used in this test.
const actualLoad = Module._load;
let outgoing = [];
let eventLog = [];
let shouldReject = false;
let limiterReject = false;
let smtpShouldFail = false;
Module._load = function(request, parent, isMain) {
    if (request === "nodemailer") return {
        createTransport: () => ({
            sendMail: async (options) => {
                eventLog.push("smtp");
                outgoing.push(options);
                if (smtpShouldFail) {
                    const error = new Error("mock provider disconnected");
                    error.code = "ECONNECTION";
                    throw error;
                }
                return { accepted: shouldReject ? [] : [options.to], rejected: shouldReject ? [options.to] : [] };
            },
        }),
    };
    if (request === "../utils/registrationEmailLimiter.js" && parent?.filename?.endsWith("config/mailer.js")) return {
        reserveRegistrationEmailSlot: async () => {
            if (limiterReject) {
                const error = new Error("rate limited");
                error.code = "REGISTRATION_EMAIL_RATE_LIMIT";
                error.statusCode = 429;
                throw error;
            }
            eventLog.push("reserved");
        },
    };
    return actualLoad.apply(this, arguments);
};
let sendRegistrationOtp;
try {
    ({ sendRegistrationOtp } = require("../config/mailer.js"));
} finally {
    Module._load = actualLoad;
}

test("registration OTP reserves account quota, stores the OTP, then sends one SMTP message", async () => {
    process.env.SMTP_HOST = "mock.smtp.invalid";
    process.env.SMTP_USER = "registration@example.invalid";
    process.env.SMTP_PASS = "mock-password";
    eventLog = [];
    outgoing = [];
    shouldReject = false;
    await sendRegistrationOtp({
        to: "new-user@example.invalid",
        html: "<p>Registration OTP</p>",
        prepare: async () => eventLog.push("saved-otp"),
    });
    assert.deepEqual(eventLog, ["reserved", "saved-otp", "smtp"]);
    assert.equal(outgoing.length, 1);
    assert.equal(outgoing[0].subject, "OTLI Client Registration OTP");
    assert.equal(outgoing[0].to, "new-user@example.invalid");
});

test("invalid recipients and rejected SMTP acceptance cannot be treated as successful", async () => {
    eventLog = [];
    await assert.rejects(sendRegistrationOtp({
        to: "bad-address", html: "test", prepare: async () => {},
    }), (error) => error.statusCode === 400);
    assert.equal(eventLog.length, 0);

    shouldReject = true;
    await assert.rejects(sendRegistrationOtp({
        to: "new-user@example.invalid", html: "test", prepare: async () => {},
    }), (error) => error.statusCode === 503);
    shouldReject = false;
});


test("a full daily quota blocks OTP database changes and SMTP entirely", async () => {
    eventLog = [];
    outgoing = [];
    limiterReject = true;
    await assert.rejects(sendRegistrationOtp({
        to: "new-user@example.invalid", html: "test",
        prepare: async () => eventLog.push("saved-otp"),
    }), (error) => error.statusCode === 429);
    limiterReject = false;
    assert.deepEqual(eventLog, []);
    assert.equal(outgoing.length, 0);
});

test("temporary SMTP failures are not automatically retried", async () => {
    eventLog = [];
    outgoing = [];
    smtpShouldFail = true;
    await assert.rejects(sendRegistrationOtp({
        to: "new-user@example.invalid", html: "test", prepare: async () => {},
    }), (error) => error.statusCode === 503);
    smtpShouldFail = false;
    assert.deepEqual(eventLog, ["reserved", "smtp"]);
    assert.equal(outgoing.length, 1);
});
