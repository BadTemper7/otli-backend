"use strict";

const {
  getEmailMonitoringReport, getCollection, parseHistoryOptions, csvRecord,
} = require("../utils/registrationEmailHistory.js");

// These endpoints are mounted beneath protect + adminOnly and reports:view.
const listEmailHistory = async (req, res) => {
  const report = await getEmailMonitoringReport({ params: req.query });
  res.set("Cache-Control", "private, no-store");
  return res.json({ success: true, ...report });
};

const exportEmailHistory = async (req, res) => {
  const { start, endExclusive, from, to, type } = parseHistoryOptions({ ...req.query, page: 1, limit: 25 });
  const query = { createdAt: { $gte: start, $lt: endExclusive } };
  if (type !== "all") query.eventType = type;
  // Streaming cursor avoids buffering an arbitrarily large reporting period.
  // Never include raw email, OTP, or SMTP provider credentials.
  const cursor = getCollection().find(query, {
    projection: { eventType: 1, flow: 1, recipientMasked: 1, count: 1, errorCode: 1, createdAt: 1 },
  }).sort({ createdAt: -1, _id: -1 });
  const filename = `registration-email-${from}-to-${to}.csv`;
  res.set({
    "Cache-Control": "private, no-store",
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "X-Content-Type-Options": "nosniff",
  });
  res.write("Timestamp (Asia/Manila),Event,Flow,Recipient (masked),Count,Error Code\r\n");
  try {
    for await (const item of cursor) {
      if (res.destroyed) break;
      if (!res.write(csvRecord(item))) {
        await new Promise((resolve) => {
          const finish = () => {
            res.off("drain", finish);
            res.off("close", finish);
            resolve();
          };
          res.once("drain", finish);
          res.once("close", finish);
        });
      }
    }
    if (!res.destroyed) res.end();
  } catch (_error) {
    console.warn("[email-monitoring] CSV export interrupted.");
    if (!res.destroyed) res.destroy(); // Cannot change HTTP code after streaming started.
  } finally {
    await cursor.close().catch(() => undefined);
  }
};

module.exports = { listEmailHistory, exportEmailHistory };
