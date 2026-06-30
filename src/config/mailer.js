import nodemailer from "nodemailer"

let transporter
let verifiedOnce = false

const getMailFrom = () => {
  return process.env.MAIL_FROM || process.env.SMTP_USER
}

export const getTransporter = () => {
  if (transporter) return transporter

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("SMTP credentials are missing in .env")
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  })

  return transporter
}

export const verifyMailer = async () => {
  const mailer = getTransporter()
  await mailer.verify()
  verifiedOnce = true
  return true
}

export const sendEmail = async ({ to, subject, html, text }) => {
  if (!to || !subject || (!html && !text)) {
    throw new Error("Email recipient, subject, and content are required.")
  }

  const mailer = getTransporter()

  if (!verifiedOnce && process.env.NODE_ENV === "development") {
    await verifyMailer()
  }

  const info = await mailer.sendMail({
    from: getMailFrom(),
    to,
    subject,
    html,
    text,
    envelope: {
      from: process.env.SMTP_USER,
      to,
    },
  })

  const accepted = Array.isArray(info.accepted) ? info.accepted : []
  const rejected = Array.isArray(info.rejected) ? info.rejected : []

  console.log("[mail] sent", {
    to,
    subject,
    messageId: info.messageId,
    accepted,
    rejected,
    response: info.response,
  })

  if (accepted.length === 0 && rejected.length > 0) {
    throw new Error(`Email was rejected by SMTP: ${rejected.join(", ")}`)
  }

  return {
    messageId: info.messageId,
    accepted,
    rejected,
    response: info.response,
  }
}
