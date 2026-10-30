"use strict";
const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  campaignKey: { type: String, required: true, unique: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  payload: { type: String, required: true, select: false },
  state: { type: String, enum: ["queued", "ingesting", "completed", "failed"], default: "queued" },
  cursor: { type: mongoose.Schema.Types.ObjectId, default: null },
  enqueued: { type: Number, default: 0 },
  skipped: { type: Number, default: 0 },
  maxRecipients: { type: Number, required: true },
  errorCode: { type: String, default: "" },
}, { timestamps: true });
module.exports = mongoose.models.EmailCampaign || mongoose.model("EmailCampaign", schema);
