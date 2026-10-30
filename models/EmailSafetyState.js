"use strict";
const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  initializedAt: { type: Date, default: Date.now },
  hmacFingerprint: { type: String, default: "" },
  payloadFingerprint: { type: String, default: "" },
}, { timestamps: true });
module.exports = mongoose.models.EmailSafetyState || mongoose.model("EmailSafetyState", schema);
