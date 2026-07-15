"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.paymentTypeUpload = exports.bookingPaymentUpload = exports.bookingPreAdviceUpload = exports.preAdviceUpload = exports.clientRegistrationUpload = exports.upload = void 0;
const multer_1 = __importDefault(require("multer"));
const allowedMimeTypes = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const storage = multer_1.default.memoryStorage();
const fileFilter = (req, file, cb) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
        return cb(new Error("Only PDF, Word, JPG, PNG, and WEBP files are allowed."));
    }
    cb(null, true);
};
exports.upload = (0, multer_1.default)({
    storage,
    fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024,
        files: 8,
    },
});
exports.clientRegistrationUpload = exports.upload.fields([
    { name: "businessPermit", maxCount: 1 },
    { name: "birCertificate", maxCount: 1 },
    { name: "validId", maxCount: 1 },
    { name: "authorizationLetter", maxCount: 1 },
    { name: "otherDocument", maxCount: 1 },
]);
exports.preAdviceUpload = exports.upload.fields([
    { name: "eir", maxCount: 1 },
    { name: "deliveryOrder", maxCount: 1 },
    { name: "bookingConfirmation", maxCount: 1 },
    { name: "packingList", maxCount: 1 },
    { name: "customsClearance", maxCount: 1 },
    { name: "otherDocument", maxCount: 1 },
]);
exports.bookingPreAdviceUpload = exports.upload.fields([
    { name: "eir", maxCount: 1 },
    { name: "deliveryOrder", maxCount: 1 },
    { name: "bookingConfirmation", maxCount: 1 },
    { name: "packingList", maxCount: 1 },
    { name: "customsClearance", maxCount: 1 },
    { name: "otherDocument", maxCount: 1 },
]);
exports.bookingPaymentUpload = exports.upload.fields([
    { name: "paymentProof", maxCount: 3 },
    { name: "otherDocument", maxCount: 2 },
]);
const paymentTypeImageUpload = (0, multer_1.default)({
    storage,
    fileFilter: (req, file, cb) => {
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
            return cb(new Error("QR image must be JPG, PNG, or WEBP."));
        }
        cb(null, true);
    },
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});
exports.paymentTypeUpload = paymentTypeImageUpload.single("qr");
