"use strict";

const { getRegistrationEmailUsage } = require("../utils/registrationEmailLimit.js");

// Protected by the existing admin-only + dashboard:view middleware in routes.
// This endpoint must never expose SMTP credentials or claim to know Hostinger's
// mailbox-wide remaining quota from an SMTP connection.
const getEmailUsage = async (_req, res) => {
    const usage = await getRegistrationEmailUsage();
    res.set("Cache-Control", "private, no-store");
    return res.json({ success: true, ...usage });
};

module.exports = { getEmailUsage };
