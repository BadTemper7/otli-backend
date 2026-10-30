"use strict";

const nodemailer = require("nodemailer");
const { reserveRegistrationEmailSlot } = require("../utils/registrationEmailLimiter.js");

let transporter;
const parseBool = (value, fallback = false) => {
    if (value === undefined || value === null || value === "")
        return fallback;
    return ["1", "true", "yes", "on"].includes(String(value).toLowerCase().trim());
};

const getTransporter = () => {
    if (transporter)
        return transporter;
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS)
        throw new Error("SMTP credentials are missing in .env");
    const port = Number(process.env.SMTP_PORT || 465);
    const secure = parseBool(process.env.SMTP_SECURE, port === 465);
    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        requireTLS: parseBool(process.env.SMTP_REQUIRE_TLS, !secure),
        tls: {
            servername: process.env.SMTP_HOST,
            rejectUnauthorized: parseBool(process.env.SMTP_TLS_REJECT_UNAUTHORIZED, true),
        },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
    });
    return transporter;
};

// This is intentionally the ONLY sending function. Booking, password-reset,
// admin, and test emails cannot invoke a general-purpose mailer anymore.
const sendRegistrationOtp = async ({ to, html, prepare }) => {
    if (typeof to !== "string" || to.length > 254 ||
        !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to) ||
        !html || typeof prepare !== "function") {
        const error = new Error("A valid registration address and OTP content are required.");
        error.statusCode = 400;
        throw error;
    }

    // Validate transport before consuming a slot. Only registration OTPs can
    // reach this path; the shared MongoDB limiter enforces the account budget.
    let mailer;
    try {
        mailer = getTransporter();
    }
    catch (_error) {
        const error = new Error("Registration email is temporarily unavailable. Please try again later.");
        error.statusCode = 503;
        error.code = "REGISTRATION_EMAIL_UNAVAILABLE";
        throw error;
    }
    await reserveRegistrationEmailSlot();

    // Write the OTP hash and expiry only after quota is reserved so rejected
    // requests never overwrite a still-valid OTP or start a resend cooldown.
    await prepare();

    let info;
    try {
        info = await mailer.sendMail({
            from: process.env.MAIL_FROM || process.env.SMTP_USER,
            to,
            subject: "OTLI Client Registration OTP",
            html,
            replyTo: process.env.MAIL_REPLY_TO || process.env.SMTP_USER,
            envelope: { from: process.env.SMTP_USER, to },
        });
    }
    catch (error) {
        // No automatic retry: the provider may have accepted a message before
        // reporting a connection failure. Avoid duplicate OTP deliveries.
        console.warn("[mail] registration OTP SMTP error", {
            code: error.code || "smtp_error",
            responseCode: Number(error.responseCode) || undefined,
        });
        const unavailableError = new Error("Registration email is temporarily unavailable. Please try again later.");
        unavailableError.statusCode = 503;
        unavailableError.code = "REGISTRATION_EMAIL_UNAVAILABLE";
        throw unavailableError;
    }
    const accepted = Array.isArray(info.accepted) ? info.accepted : [];
    if (!accepted.some((email) => String(email).toLowerCase() === to.toLowerCase())) {
        const error = new Error("Registration email was not accepted. Please try again later.");
        error.statusCode = 503;
        error.code = "REGISTRATION_EMAIL_UNAVAILABLE";
        throw error;
    }
    // SMTP acceptance is NOT proof of inbox delivery; do not log email/OTP.
    console.info("[mail] registration OTP accepted by SMTP");
};

module.exports = { sendRegistrationOtp };
