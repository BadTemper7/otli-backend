"use strict";
const express = require("express");
const crypto = require("node:crypto");
const { recordProviderEvent, unsubscribe, verifyUnsubscribeToken } = require("../services/emailService.js");
const router = express.Router();
const noCache = (_, res, next) => { res.set("Cache-Control", "no-store"); res.set("Referrer-Policy", "no-referrer"); res.set("X-Robots-Tag", "noindex"); next(); };
router.use(noCache);
// GET is only a confirmation page: scanners must never unsubscribe users.
router.get("/unsubscribe", (req, res) => {
  const token = String(req.query.token || "");
  if (!verifyUnsubscribeToken(token)) return res.status(400).type("text/plain").send("Invalid unsubscribe link.");
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Manage email preferences</title></head><body><main><h1>Unsubscribe from promotional emails</h1><p>Transactional notices, password resets, and verification codes are not affected.</p><form method="POST" action="/api/email/unsubscribe"><input type="hidden" name="token" value="${token}"><button type="submit">Confirm unsubscribe</button></form></main></body></html>`);
});
router.post("/unsubscribe", async (req, res) => {
  try {
    const token = req.body?.token || req.query?.token;
    await unsubscribe(token);
    if (req.is("application/x-www-form-urlencoded") || !req.accepts("json")) return res.type("html").send("<!doctype html><html><body><h1>Unsubscribed</h1><p>You will no longer receive promotional emails.</p></body></html>");
    return res.json({ success: true, message: "Promotional email subscription cancelled." });
  } catch (e) { return res.status(e.status || 400).json({ success: false, message: "Invalid or expired unsubscribe link." }); }
});
// The provider must be configured to POST its own normalized events here.
// Generic signed schema: {eventId, type, messageId}. No unsigned events are accepted.
async function signedWebhook(req, res) {
  const webhookSecret = process.env.EMAIL_WEBHOOK_SECRET || "";
  if (webhookSecret.length < 32 || !Buffer.isBuffer(req.body)) return res.status(503).json({ success: false });
  const received = String(req.header("x-email-signature") || "").replace(/^sha256=/i, "");
  const expected = crypto.createHmac("sha256", webhookSecret).update(req.body).digest("hex");
  if (!/^[a-f0-9]{64}$/i.test(received) || !crypto.timingSafeEqual(Buffer.from(received.toLowerCase()), Buffer.from(expected))) return res.status(401).json({ success: false });
  let body;
  try { body = JSON.parse(req.body.toString("utf8")); }
  catch { return res.status(400).json({ success: false }); }
  try {
    const result = await recordProviderEvent(body);
    return res.status(202).json({ success: true, ...result });
  } catch (e) { return res.status(e.status || 503).json({ success: false, code: "EVENT_PROCESSING_ERROR" }); }
}
module.exports = { router, signedWebhook };
