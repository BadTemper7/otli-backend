"use strict";
// Read-only DNS preflight: it can detect missing records, but not prove SPF/DKIM/DMARC pass on a real message.
require("dotenv").config();
const dns = require("node:dns").promises;
const sender = String(process.env.MAIL_FROM || process.env.SMTP_USER || "");
const email = sender.match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/i);
if (!email) { console.error("Set MAIL_FROM (or SMTP_USER) to a valid sending address"); process.exitCode = 1; }
else {
  const domain = email[1].toLowerCase();
  const senderDomain = (String(process.env.SMTP_USER || "").split("@")[1] || "").toLowerCase();
  const selector = process.env.EMAIL_DKIM_SELECTOR;
  const txt = async target => { try { return (await dns.resolveTxt(target)).map(parts => parts.join("")); } catch { return []; } };
  (async () => {
    const spf = (await txt(domain)).filter(record => record.toLowerCase().startsWith("v=spf1"));
    const dmarc = (await txt(`_dmarc.${domain}`)).filter(record => record.toLowerCase().startsWith("v=dmarc1"));
    const dkim = selector ? await txt(`${selector}._domainkey.${domain}`) : [];
    console.log(JSON.stringify({ domain, envelopeDomain: senderDomain || null, spfPresent: spf.length === 1, spfCount: spf.length,
      dmarcPresent: dmarc.length >= 1, dmarcPolicy: dmarc[0]?.match(/\bp=(none|quarantine|reject)/i)?.[1] || null,
      dkimSelectorChecked: selector || null, dkimTxtPresent: dkim.some(x => /^v=DKIM1|p=/i.test(x)),
      domainAlignmentHint: senderDomain === domain ? "same-address-domain" : "different-domains-check-DMARC-alignment",
      caveat: "Verify DKIM signing and SPF/DMARC alignment with an authorized TEST message; TXT checks alone are not proof of authentication." }, null, 2));
  })().catch(e => { console.error("DNS check failed:", e.code || "DNS_ERROR"); process.exitCode = 1; });
}
