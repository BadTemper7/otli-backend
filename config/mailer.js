"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmail = exports.verifyMailer = exports.getTransporter = void 0;
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
    const mailer = (0, exports.getTransporter)();
    await mailer.verify();
    verifiedOnce = true;
    return true;
};
exports.verifyMailer = verifyMailer;
const sendEmail = async ({ to, subject, html, text }) => {
    if (!to || !subject || (!html && !text)) {
        throw new Error("Email recipient, subject, and content are required.");
    }
    const mailer = (0, exports.getTransporter)();
    if (!verifiedOnce && process.env.NODE_ENV === "development") {
        await (0, exports.verifyMailer)();
    }
    const info = await mailer.sendMail({
        from: getMailFrom(),
        to,
        subject,
        html,
        text,
        replyTo: process.env.MAIL_REPLY_TO || process.env.SMTP_USER,
        envelope: {
            from: process.env.SMTP_USER,
            to,
        },
    });
    const accepted = Array.isArray(info.accepted) ? info.accepted : [];
    const rejected = Array.isArray(info.rejected) ? info.rejected : [];
    console.log("[mail] sent", {
        to,
        subject,
        messageId: info.messageId,
        accepted,
        rejected,
        response: info.response,
    });
    if (accepted.length === 0 && rejected.length > 0) {
        throw new Error(`Email was rejected by SMTP: ${rejected.join(", ")}`);
    }
    return {
        messageId: info.messageId,
        accepted,
        rejected,
        response: info.response,
    };
};
exports.sendEmail = sendEmail;
