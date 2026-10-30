"use strict";
const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  type: { type: String, required: true },
  messageId: { type: String, default: "" },
  processedAt: { type: Date, default: null },
}, { timestamps: true });
module.exports = mongoose.models.EmailProviderEvent || mongoose.model("EmailProviderEvent", schema);
