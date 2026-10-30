"use strict";
// Dedicated worker option. Set EMAIL_WORKER_ENABLED=false on the web API.
require("dotenv").config();
const mongoose = require("mongoose");
const { startWorkers, stopWorkers } = require("../services/emailService.js");
const { close } = require("../services/emailQueue.js");
(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  await mongoose.connect(process.env.MONGODB_URI);
  await startWorkers();
  console.log("Email queue workers running; SMTP sends remain rate limited.");
})().catch(e => { console.error("Email worker failed to start:", e.code || "CONFIGURATION_ERROR"); process.exit(1); });
let exiting = false;
async function shutdown() {
  if (exiting) return; exiting = true;
  await stopWorkers(); await close(); await mongoose.disconnect(); process.exit(0);
}
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
