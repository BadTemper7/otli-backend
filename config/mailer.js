"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmail = exports.sendNow = exports.verifyMailer = exports.getTransporter = void 0;
const nodemailer_1 = __importDefault(require("nodemailer"));
let transporter;
let verifiedOnce = false;
const parseBool = (value, defaultValue = false) => {
    if (value === undefined || value === null || value === "")
        return defaultValue;
    return ["1", "true", "yes", "on"].includes(String(value).toLowerCase().trim());
};
const getMailFrom = () => {
    return process.env.MAIL_FROM || process.env.SMTP_USER;
};
const getTransporter = () => {
    if (transporter)
        return transporter;
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        throw new Error("SMTP credentials are missing in .env");
    }
    const port = Number(process.env.SMTP_PORT || 465);
    const secure = parseBool(process.env.SMTP_SECURE, port === 465);
    transporter = nodemailer_1.default.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
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
exports.getTransporter = getTransporter;
const verifyMailer = async () => {
    if (process.env.EMAIL_DELIVERY_MODE === "mock" && ["development", "test"].includes(process.env.NODE_ENV)) return true;
    const mailer = (0, exports.getTransporter)();
    await mailer.verify();
    verifiedOnce = true;
    return true;
};
exports.verifyMailer = verifyMailer;
// Internal transport only. Controllers must call sendEmail, which enqueues safely.
const sendNow = async ({ to, subject, html, text, headers }) => {
    if (process.env.EMAIL_DELIVERY_MODE === "mock") {
        if (process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "development") throw new Error("Mock SMTP mode is forbidden in production");
        const response = String(process.env.EMAIL_MOCK_RESPONSE || "accepted");
        if (response !== "accepted") {
            const mockErrors = { throttle: [421, "too many messages"], temporary: [451, "temporary problem"], hard_bounce: [550, "5.1.1 no such mailbox"], suspended: [554, "account suspended"], auth: [535, "authentication failed"], uncertain: [0, "connection lost after DATA"] };
            const [responseCode, description] = mockErrors[response] || [550, "permanent failure"];
            const error = new Error(description);
            if (responseCode) error.responseCode = responseCode;
            throw error;
        }
        return { messageId: `mock-${require("node:crypto").randomUUID()}` };
    }
    const info = await (0, exports.getTransporter)().sendMail({
        from: getMailFrom(),
        to,
        subject,
        html,
        text,
        headers,
        replyTo: process.env.MAIL_REPLY_TO || process.env.SMTP_USER,
        envelope: { from: process.env.SMTP_USER, to },
    });
    if (!Array.isArray(info.accepted) || info.accepted.length !== 1) {
        const e = new Error("Provider did not accept the single recipient");
        e.responseCode = Array.isArray(info.rejected) && info.rejected.length ? 550 : 0;
        throw e;
    }
    // Never log recipients, message bodies, OTPs, provider replies, or credentials.
    return { messageId: info.messageId || "" };
};
exports.sendNow = sendNow;
const sendEmail = options => require("../services/emailService.js").enqueueEmail(options);
exports.sendEmail = sendEmail;
