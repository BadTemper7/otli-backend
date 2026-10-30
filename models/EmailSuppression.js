"use strict";
const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  addressHash: { type: String, required: true },
  scope: { type: String, enum: ["all", "marketing"], required: true },
  reason: { type: String, enum: ["hard_bounce", "complaint", "unsubscribe", "admin"], required: true },
}, { timestamps: true });
schema.index({ addressHash: 1, scope: 1 }, { unique: true });
module.exports = mongoose.models.EmailSuppression || mongoose.model("EmailSuppression", schema);
