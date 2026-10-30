"use strict";
const crypto = require("node:crypto");
const { digest } = require("./emailPolicy.js");
function key() {
  const value = Buffer.from(process.env.EMAIL_PAYLOAD_KEY || "", "base64");
  if (value.length !== 32) throw new Error("EMAIL_PAYLOAD_KEY must be 32 random base64 bytes");
  return value;
}
function secret() {
  if (!process.env.EMAIL_HMAC_SECRET || process.env.EMAIL_HMAC_SECRET.length < 32) throw new Error("EMAIL_HMAC_SECRET must be at least 32 characters");
  return process.env.EMAIL_HMAC_SECRET;
}
const addressHash = address => digest(address, secret());
const eventHash = (address, event) => digest(`${address}\u0000${event}`, secret());
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const payload = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), payload.toString("base64url")].join(".");
}
function decrypt(stored) {
  const [i, t, p] = String(stored).split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(i, "base64url"));
  decipher.setAuthTag(Buffer.from(t, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(p, "base64url")), decipher.final()]).toString("utf8"));
}
function unsubscribeToken(id) {
  const payload = String(id);
  return `${payload}.${digest(`unsubscribe:${payload}`, secret())}`;
}
function verifyUnsubscribeToken(value) {
  const [id, mac, extra] = String(value || "").split(".");
  if (extra || !/^[a-f\d]{24}$/.test(id || "") || !/^[a-f\d]{64}$/.test(mac || "")) return null;
  const expected = digest(`unsubscribe:${id}`, secret());
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) ? id : null;
}
module.exports = { encrypt, decrypt, addressHash, eventHash, unsubscribeToken, verifyUnsubscribeToken, key, secret };
