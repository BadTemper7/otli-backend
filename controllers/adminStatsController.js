"use strict";

const User = require("../models/User.js").default;

// Count the entire collection using a single database aggregation. These
// endpoints intentionally have no page/limit inputs and do not read table rows.
const summarizeUsers = async (userType) => {
  const groups = await User.aggregate([
    { $match: { userType } },
    { $group: { _id: { status: "$status", role: "$role" }, count: { $sum: 1 } } },
  ]);
  const byStatus = {};
  const byRole = {};
  let total = 0;
  for (const group of groups) {
    const count = Number(group.count) || 0;
    const status = String(group._id?.status || "unknown");
    const role = String(group._id?.role || "unknown");
    total += count;
    byStatus[status] = (byStatus[status] || 0) + count;
    byRole[role] = (byRole[role] || 0) + count;
  }
  return { total, byStatus, byRole };
};

const getAdminUserStats = async (_req, res) => {
  const { total, byStatus, byRole } = await summarizeUsers("admin");
  return res.json({
    success: true,
    stats: {
      accounts: total,
      active: (byStatus.active || 0) + (byStatus.verified || 0),
      staff: byRole.staff || 0,
    },
    statusOptions: Object.keys(byStatus).sort(),
  });
};

const getClientRegistrationStats = async (_req, res) => {
  const { byStatus } = await summarizeUsers("client");
  return res.json({
    success: true,
    stats: {
      verified: (byStatus.active || 0) + (byStatus.verified || 0),
      pending: (byStatus.pending || 0) + (byStatus.resubmitted || 0),
      rejected: byStatus.rejected || 0,
    },
  });
};

module.exports = { getAdminUserStats, getClientRegistrationStats, summarizeUsers };
