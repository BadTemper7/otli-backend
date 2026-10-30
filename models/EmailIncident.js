"use strict";
const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  category: { type: String, enum: ["all", "transactional", "marketing"], required: true },
  severity: { type: String, enum: ["warning", "critical"], required: true },
  reason: { type: String, required: true },
  source: { type: String, default: "monitor" },
  clearedAt: { type: Date, default: null },
  clearedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  clearanceNote: { type: String, default: "" },
}, { timestamps: true });
schema.index({ clearedAt: 1, createdAt: -1 });
module.exports = mongoose.models.EmailIncident || mongoose.model("EmailIncident", schema);
