"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const authController_js_1 = require("../controllers/authController.js");
const authMiddleware_js_1 = require("../middleware/authMiddleware.js");
const uploadMiddleware_js_1 = require("../middleware/uploadMiddleware.js");
const asyncHandler_js_1 = __importDefault(require("../utils/asyncHandler.js"));
const { watchRegistrationRequest, markRegistrationUploadComplete } = require("../utils/registrationTiming.js");
const router = express_1.default.Router();
router.post("/login", (0, asyncHandler_js_1.default)(authController_js_1.login));
router.get("/me", authMiddleware_js_1.protect, (0, asyncHandler_js_1.default)(authController_js_1.me));
router.patch("/change-password", authMiddleware_js_1.protect, (0, asyncHandler_js_1.default)(authController_js_1.changePassword));
router.post("/forgot-password", (0, asyncHandler_js_1.default)(authController_js_1.forgotPassword));
router.post("/reset-password", (0, asyncHandler_js_1.default)(authController_js_1.resetPassword));
router.post("/email/test", (0, asyncHandler_js_1.default)(authController_js_1.sendTestEmail));
// Lightweight quota check before uploading documents; does not reserve a slot.
router.get("/client/register/email-status", (0, asyncHandler_js_1.default)(authController_js_1.checkRegistrationEmailAvailability));
// Manual review stays pending and requires staff verification; no email sent.
const manualRegistrationLimiter = require("express-rate-limit").rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { success: false, message: "Too many manual registration submissions. Please try again later." },
});
router.post("/client/register/manual-review", watchRegistrationRequest("manual-review"), manualRegistrationLimiter, uploadMiddleware_js_1.clientRegistrationUpload, markRegistrationUploadComplete, (0, asyncHandler_js_1.default)(authController_js_1.submitClientManualRegistration));
router.post("/client/register/request-otp", watchRegistrationRequest("request-otp"), uploadMiddleware_js_1.clientRegistrationUpload, markRegistrationUploadComplete, (0, asyncHandler_js_1.default)(authController_js_1.requestClientRegistrationOtp));
router.post("/client/register/resend-otp", watchRegistrationRequest("resend-otp"), (0, asyncHandler_js_1.default)(authController_js_1.resendClientRegistrationOtp));
router.post("/client/register/verify-otp", (0, asyncHandler_js_1.default)(authController_js_1.verifyClientRegistrationOtp));
exports.default = router;
