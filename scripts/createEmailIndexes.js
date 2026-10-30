"use strict";
// Safe, additive schema/index migration. Existing users stay opted OUT of marketing.
require("dotenv").config();
const mongoose = require("mongoose");
const models = ["User", "OutboundEmail", "EmailSuppression", "EmailIncident", "EmailCampaign", "EmailProviderEvent", "EmailSafetyState"];
(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI missing");
  await mongoose.connect(process.env.MONGODB_URI);
  for (const name of models) {
    const Model = name === "User" ? require("../models/User.js").default : require(`../models/${name}.js`);
    await Model.createIndexes();
    console.log(`Indexes verified: ${name}`);
  }
  await mongoose.disconnect();
})().catch(err => { console.error("Email index setup failed:", err.code || "DATABASE_ERROR"); process.exit(1); });
