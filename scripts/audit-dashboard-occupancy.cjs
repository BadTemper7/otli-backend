"use strict";
/**
 * Read-only reconciliation of the live YardBlock allocation ledger.
 * Run from onetrue-server with MONGODB_URI configured:
 *   npm run audit:occupancy
 *
 * The check does not modify bookings, blocks, or inventory records.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Booking = require("../models/Booking.js").default;
const InventoryContainer = require("../models/InventoryContainer.js").default;
const YardBlock = require("../models/YardBlock.js").default;
const { currentYardUtilization, slotUsage } = require("../utils/dashboardOccupancy.js");

const reservedStatuses = [
  "approved_area_assigned", "gate_in_approved", "stored_in_assigned_area",
  "gate_out_requested", "gate_out_approved", "gate_out_reversal_requested",
];
const id = (value) => String(value?._id || value || "");
const round = (n) => Math.round(n * 100) / 100;

const main = async () => {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI must be set. Run the audit in staging with read-only DB credentials.");
    process.exitCode = 2;
    return;
  }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 12000 });
  try {
    const [blocks, bookings, inventory] = await Promise.all([
      YardBlock.find({ status: { $in: ["active", "full"] } }).select("status code containerSize teuSlots occupiedSlots").lean(),
      Booking.find({ status: { $in: reservedStatuses } }).select("assignedBlock containerSize").lean(),
      InventoryContainer.find({ status: { $ne: "released" } }).select("block containerSize").lean(),
    ]);
    const byBlock = new Map(blocks.map((b) => [id(b), { code: b.code, size: b.containerSize, recorded: Number(b.occupiedSlots) || 0, calculated: 0 }]));
    let bookingsMissingBlock = 0;
    let legacyMissingBlock = 0;
    for (const b of bookings) {
      const block = byBlock.get(id(b.assignedBlock));
      if (block) block.calculated += slotUsage(b.containerSize, block.size);
      else bookingsMissingBlock++;
    }
    for (const c of inventory) {
      const block = byBlock.get(id(c.block));
      if (block) block.calculated += slotUsage(c.containerSize, block.size);
      else legacyMissingBlock++;
    }
    const totals = currentYardUtilization(blocks);
    const derived = round([...byBlock.values()].reduce((sum, block) => sum + block.calculated, 0));
    const discrepancies = [...byBlock.values()]
      .map((block) => ({ ...block, difference: round(block.recorded - block.calculated) }))
      .filter((block) => Math.abs(block.difference) > 0.01);
    console.log(JSON.stringify({
      auditedAt: new Date().toISOString(),
      blockCount: blocks.length,
      assignedBookingRecords: bookings.length,
      activeLegacyRecords: inventory.length,
      stored: { totalSlots: totals.capacity, occupiedSlots: totals.occupied, occupancyPercent: totals.rate },
      recomputed: { occupiedSlots: derived, occupancyPercent: totals.capacity ? round(derived / totals.capacity * 100) : null },
      missingBlock: { bookings: bookingsMissingBlock, legacyInventory: legacyMissingBlock },
      discrepancies: discrepancies.map(({ code, recorded, calculated, difference }) => ({
        blockCode: code, recorded, calculated: round(calculated), difference,
      })),
    }, null, 2));
    if (discrepancies.length || bookingsMissingBlock || legacyMissingBlock || totals.capacity <= 0) {
      console.error("Occupancy reconciliation needs investigation. No changes were made.");
      process.exitCode = 1;
    } else {
      console.log("PASS: stored yard allocation matches the underlying assigned container records.");
    }
  } finally {
    await mongoose.disconnect();
  }
};
main().catch((error) => {
  console.error(`Read-only audit failed: ${error.message}`);
  process.exitCode = 2;
});
