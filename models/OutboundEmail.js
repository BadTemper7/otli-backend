"use strict";
const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  eventKey: { type: String, required: true, unique: true, index: true },
  addressHash: { type: String, required: true, index: true },
  // A recipient and AES-GCM encrypted body are required until provider submission.
  to: { type: String, required: true },
  payload: { type: String, default: null, select: false },
  category: { type: String, enum: ["transactional", "marketing"], required: true, index: true },
  campaign: { type: mongoose.Schema.Types.ObjectId, ref: "EmailCampaign", default: null },
  eventType: { type: String, default: "notification" },
  status: { type: String, enum: ["queued", "sending", "accepted", "delivered", "failed", "suppressed", "uncertain", "expired", "bounced", "complained"], default: "queued", index: true },
  reason: { type: String, default: "" },
  providerMessageId: { type: String, default: "", index: true },
  attempts: { type: Number, default: 0 },
  acceptedAt: { type: Date, default: null, index: true },
  deliveredAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null },
  otpContext: { type: mongoose.Schema.Types.Mixed, default: null, select: false },
}, { timestamps: true });
schema.index({ category: 1, status: 1, createdAt: -1 });
schema.index({ addressHash: 1, acceptedAt: -1 });
module.exports = mongoose.models.OutboundEmail || mongoose.model("OutboundEmail", schema);
