"use strict";

const { getRegistrationEmailUsage, reconcileUnusedRegistrationEmailSlots } = require("../utils/registrationEmailLimit.js");

// Protected by the existing admin-only + dashboard:view middleware in routes.
// This endpoint must never expose SMTP credentials or claim to know Hostinger's
// mailbox-wide remaining quota from an SMTP connection.
const getEmailUsage = async (_req, res) => {
    const usage = await getRegistrationEmailUsage();
    res.set("Cache-Control", "private, no-store");
    return res.json({ success: true, ...usage });
};

// Super Admin only. There is no ability to clear confirmed/unknown SMTP sends,
// force-release legacy reservations or increase the Hostinger/provider quota.
// Audit middleware logs this admin mutation automatically.
const reconcileEmailUsage = async (_req, res) => {
    const result = await reconcileUnusedRegistrationEmailSlots();
    const usage = await getRegistrationEmailUsage();
    res.set("Cache-Control", "private, no-store");
    return res.json({
        success: true,
        ...result,
        usage,
        message: result.released
            ? `${result.released} confirmed unused pre-SMTP reservation(s) released.`
            : "No safely reclaimable slots found. Older unclassified reservations remain protected. Clients may submit for manual review without email.",
    });
};

module.exports = { getEmailUsage, reconcileEmailUsage };
