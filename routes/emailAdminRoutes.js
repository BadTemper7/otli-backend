"use strict";
const express = require("express");
const router = express.Router();
const User = require("../models/User.js").default;
const Incident = require("../models/EmailIncident.js");
const Campaign = require("../models/EmailCampaign.js");
const auth = require("../middleware/authMiddleware.js");
const asyncHandler = require("../utils/asyncHandler.js").default;
const { dashboard, pauseQueues, resumeQueues } = require("../services/emailMonitoring.js");
const { createCampaign, recordProviderEvent, reconcileOutbox, suppress } = require("../services/emailService.js");
const { normalizeEmail } = require("../services/emailPolicy.js");
const { addressHash } = require("../services/emailCrypto.js");
router.get("/monitor", auth.requirePermission("settings", "view"), asyncHandler(async (req, res) => res.json({ success: true, email: await dashboard() })));
router.get("/incidents", auth.superAdminOnly, asyncHandler(async (req, res) => res.json({ success: true, incidents: await Incident.find().sort({ createdAt: -1 }).limit(100).lean() })));
router.get("/campaigns", auth.superAdminOnly, asyncHandler(async (req, res) => res.json({ success: true, campaigns: await Campaign.find().select("-payload").sort({ createdAt: -1 }).limit(50).lean() })));
router.post("/campaigns", auth.superAdminOnly, asyncHandler(async (req, res) => {
  const result = await createCampaign({ campaignKey: req.body.campaignKey, subject: req.body.subject, html: req.body.html, text: req.body.text, maxRecipients: req.body.maxRecipients, createdBy: req.user._id });
  res.status(202).json({ success: true, campaign: result, message: "Campaign queued for consent-checked, rate-limited ingestion." });
}));
router.post("/pause", auth.superAdminOnly, asyncHandler(async (req, res) => {
  if (!["all", "marketing", "transactional"].includes(req.body.category)) return res.status(400).json({ success: false, message: "Invalid category" });
  await pauseQueues(req.body.category, "admin_manual_pause", "administrator");
  res.json({ success: true, status: "Paused" });
}));
router.post("/resume", auth.superAdminOnly, asyncHandler(async (req, res) => {
  await resumeQueues(req.body.category, req.user._id, String(req.body.recoveryNote || ""), req.body.providerClearanceConfirmed === true);
  res.json({ success: true, message: "Authorized resume recorded." });
}));
router.post("/suppress", auth.superAdminOnly, asyncHandler(async (req, res) => {
  const address = normalizeEmail(req.body.email);
  if (!address || !["all", "marketing"].includes(req.body.scope)) return res.status(400).json({ success: false, message: "Valid email and scope required" });
  await suppress(addressHash(address), req.body.scope, "admin");
  if (req.body.scope === "marketing") await User.updateOne({ email: address }, { $set: { "marketingEmailConsent.enabled": false, "marketingEmailConsent.unsubscribedAt": new Date() } });
  res.json({ success: true, message: "Suppression recorded." });
}));
// For manually confirmed provider evidence. Does not create fabricated delivery data.
router.post("/provider-events", auth.superAdminOnly, asyncHandler(async (req, res) => res.status(202).json({ success: true, event: await recordProviderEvent(req.body) })));
router.post("/reconcile", auth.superAdminOnly, asyncHandler(async (req, res) => { await reconcileOutbox(); res.json({ success: true }); }));
module.exports = router;
