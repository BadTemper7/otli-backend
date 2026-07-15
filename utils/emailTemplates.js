"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bookingStatusEmailTemplate = exports.otpEmailTemplate = void 0;
const otpEmailTemplate = ({ title, otp, message }) => {
    const expiry = process.env.EMAIL_OTP_EXPIRES_MINUTES || 10;
    return `
    <div style="font-family:Arial,sans-serif;background:#f6f8fb;padding:24px;color:#111827;">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;border:1px solid #e5e7eb;">
        <h2 style="margin:0 0 10px;font-size:22px;color:#0f172a;">${title}</h2>
        <p style="margin:0 0 18px;color:#475569;">${message}</p>
        <div style="background:#0f172a;color:#ffffff;text-align:center;border-radius:12px;padding:18px;margin:20px 0;">
          <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#cbd5e1;">Your OTP Code</div>
          <div style="font-size:34px;font-weight:800;letter-spacing:8px;margin-top:6px;">${otp}</div>
        </div>
        <p style="margin:0;color:#475569;">This code will expire in ${expiry} minutes.</p>
        <p style="margin:16px 0 0;color:#94a3b8;font-size:13px;">If you did not request this, please ignore this email.</p>
      </div>
    </div>
  `;
};
exports.otpEmailTemplate = otpEmailTemplate;
const bookingStatusEmailTemplate = ({ title, reference, status, billingStatus, message, details = [], qrCodeValue = "", trackingUrl = "" }) => {
    const safeDetails = Array.isArray(details) ? details : [];
    return `
    <div style="font-family:Arial,sans-serif;background:#f6f8fb;padding:24px;color:#111827;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;border:1px solid #e5e7eb;">
        <div style="font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#0f766e;">One True Logistics Inc.</div>
        <h2 style="margin:10px 0 8px;font-size:24px;color:#0f172a;">${title}</h2>
        <p style="margin:0 0 18px;color:#475569;line-height:1.6;">${message}</p>
        <div style="background:#0f172a;color:#ffffff;border-radius:14px;padding:18px;margin:18px 0;">
          <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#cbd5e1;">Booking Reference</div>
          <div style="font-size:24px;font-weight:800;margin-top:4px;">${reference}</div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-top:16px;">
          <tbody>
            <tr><td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#64748b;font-weight:700;">Booking Status</td><td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#0f172a;font-weight:800;text-transform:capitalize;">${String(status || "").replaceAll("_", " ")}</td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#64748b;font-weight:700;">Billing Status</td><td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#0f172a;font-weight:800;text-transform:capitalize;">${String(billingStatus || "").replaceAll("_", " ")}</td></tr>
            ${safeDetails.map((item) => `<tr><td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#64748b;font-weight:700;">${item.label}</td><td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#0f172a;font-weight:800;">${item.value || "-"}</td></tr>`).join("")}
          </tbody>
        </table>
        ${qrCodeValue ? `<div style="margin-top:18px;border:1px solid #e5e7eb;border-radius:14px;padding:16px;background:#f8fafc;"><div style="font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#64748b;">Booking QR Value</div><div style="margin-top:8px;font-size:15px;font-weight:800;color:#0f172a;word-break:break-all;">${qrCodeValue}</div></div>` : ""}
        ${trackingUrl ? `<p style="margin:18px 0 0;"><a href="${trackingUrl}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:800;border-radius:12px;padding:12px 18px;">Track Booking Status</a></p>` : ""}
        <p style="margin:18px 0 0;color:#94a3b8;font-size:13px;">This is an automated notification. Use the booking number on the tracking page or login to the OTLI portal to view full details.</p>
      </div>
    </div>
  `;
};
exports.bookingStatusEmailTemplate = bookingStatusEmailTemplate;
