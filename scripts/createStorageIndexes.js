"use strict";

// Optional one-time production index initialization. Safe: creates only
// missing indexes and never drops collections, indexes, or stored records.
require("dotenv").config();
const mongoose = require("mongoose");
const Booking = require("../models/Booking.js").default;
const InventoryContainer = require("../models/InventoryContainer.js").default;

const url = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!url) {
    console.error("MONGO_URI or MONGODB_URI is required.");
    process.exitCode = 1;
} else {
    (async () => {
        await mongoose.connect(url, { autoIndex: false });
        await Promise.all([
            Booking.collection.createIndex({ assignedArea: 1, status: 1, updatedAt: -1, _id: -1 }),
            Booking.collection.createIndex({ assignedArea: 1, assignedBlock: 1, status: 1, updatedAt: -1, _id: -1 }),
            InventoryContainer.collection.createIndex({ area: 1, status: 1, createdAt: -1, _id: -1 }),
            InventoryContainer.collection.createIndex({ area: 1, block: 1, status: 1, createdAt: -1, _id: -1 }),
        ]);
        console.log("Storage paging indexes are ready. No application data was modified.");
    })().catch((error) => {
        console.error("Storage index creation failed:", error.message);
        process.exitCode = 1;
    }).finally(() => mongoose.disconnect());
}
