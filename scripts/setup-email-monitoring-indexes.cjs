"use strict";
require("dotenv").config();
const mongoose = require("mongoose");
const { COLLECTION_NAME } = require("../utils/registrationEmailHistory.js");

(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required.");
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
  });
  const store = mongoose.connection.db.collection(COLLECTION_NAME);
  // Retain 365 days of masked historical activity to avoid unbounded storage.
  await store.createIndex({ createdAt: 1 }, {
    name: "email_monitoring_history_365d",
    expireAfterSeconds: 365 * 24 * 60 * 60,
  });
  await store.createIndex({ eventType: 1, createdAt: -1 }, { name: "email_monitoring_type_date" });
  await store.createIndex({ createdAt: -1, _id: -1 }, { name: "email_monitoring_sort" });
  console.log("Registration email monitoring indexes are ready (365-day retention).");
})().catch((_error) => {
  console.error("Could not create email monitoring indexes. Check MongoDB connectivity and database permissions.");
  process.exitCode = 1;
}).finally(async () => {
  await mongoose.disconnect().catch(() => undefined);
});
