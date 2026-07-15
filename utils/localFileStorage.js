"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DOCUMENTS_ROOT = path.resolve(
  process.env.DOCUMENTS_DIR || path.join(process.cwd(), "documents"),
);

const sanitizeSegment = (value, fallback = "client") => {
  const cleaned = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return cleaned || fallback;
};

const sanitizeExtension = (originalName = "", mimeType = "") => {
  const originalExtension = path.extname(String(originalName)).toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(originalExtension)) {
    return originalExtension;
  }

  const mimeExtensions = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  };

  return mimeExtensions[mimeType] || "";
};

const ensureDocumentsRoot = async () => {
  await fs.promises.mkdir(DOCUMENTS_ROOT, { recursive: true });
  return DOCUMENTS_ROOT;
};

const getClientFolderName = (client) => {
  if (client && typeof client === "object") {
    const uniqueId = client._id || client.id || client.clientId;
    if (uniqueId) {
      return sanitizeSegment(String(uniqueId), "client");
    }
  }

  if (typeof client === "string" || typeof client === "number") {
    return sanitizeSegment(String(client), "client");
  }

  return "client";
};

const saveUploadedFile = async ({
  file,
  clientId,
  clientName,
  category = "document",
  prefix = "file",
}) => {
  if (!file?.buffer) {
    throw new Error("Uploaded file buffer is missing.");
  }

  await ensureDocumentsRoot();

  const clientFolder = getClientFolderName(clientId || clientName);
  const destinationFolder = path.join(DOCUMENTS_ROOT, clientFolder);
  await fs.promises.mkdir(destinationFolder, { recursive: true });

  const extension = sanitizeExtension(file.originalname, file.mimetype);
  const originalBase = sanitizeSegment(
    path.basename(String(file.originalname || "file"), path.extname(String(file.originalname || ""))),
    "file",
  ).slice(0, 50);
  const safeCategory = sanitizeSegment(category, "document");
  const safePrefix = sanitizeSegment(prefix, "file");
  const uniqueId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const storedFileName = `${safeCategory}-${safePrefix}-${uniqueId}-${originalBase}${extension}`;
  const absolutePath = path.join(destinationFolder, storedFileName);

  await fs.promises.writeFile(absolutePath, file.buffer, { flag: "wx" });

  const publicId = `${clientFolder}/${storedFileName}`;
  const url = `/documents/${publicId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;

  return {
    url,
    secureUrl: url,
    publicId,
    resourceType: "local",
    absolutePath,
    storedFileName,
  };
};

const resolveStoredFilePath = (publicIdOrUrl) => {
  if (!publicIdOrUrl) return null;

  let relativePath = String(publicIdOrUrl).trim();

  try {
    if (/^https?:\/\//i.test(relativePath)) {
      relativePath = new URL(relativePath).pathname;
    }
  } catch {
    return null;
  }

  relativePath = decodeURIComponent(relativePath)
    .replace(/^\/+documents\/+/, "")
    .replace(/^\/+/, "");

  const absolutePath = path.resolve(DOCUMENTS_ROOT, relativePath);
  const rootWithSeparator = `${DOCUMENTS_ROOT}${path.sep}`;

  if (absolutePath !== DOCUMENTS_ROOT && !absolutePath.startsWith(rootWithSeparator)) {
    return null;
  }

  return absolutePath;
};

const deleteLocalFile = async (publicIdOrUrl) => {
  const filePath = resolveStoredFilePath(publicIdOrUrl);
  if (!filePath) return false;

  try {
    await fs.promises.unlink(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

module.exports = {
  DOCUMENTS_ROOT,
  sanitizeSegment,
  ensureDocumentsRoot,
  getClientFolderName,
  saveUploadedFile,
  deleteLocalFile,
};
