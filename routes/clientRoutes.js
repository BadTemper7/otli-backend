"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const preAdviceController_js_1 = require("../controllers/preAdviceController.js");
const bookingController_js_1 = require("../controllers/bookingController.js");
const authMiddleware_js_1 = require("../middleware/authMiddleware.js");
const uploadMiddleware_js_1 = require("../middleware/uploadMiddleware.js");
const authController_js_1 = require("../controllers/authController.js");
const asyncHandler_js_1 = __importDefault(require("../utils/asyncHandler.js"));
const billingRateController_js_1 = require("../controllers/billingRateController.js");
const paymentTypeController_js_1 = require("../controllers/paymentTypeController.js");
const notificationController_js_1 = require("../controllers/notificationController.js");
const router = express_1.default.Router();
router.use(authMiddleware_js_1.protect, authMiddleware_js_1.clientOnly);

// Explicit opt-in/opt-out: no administrator may silently opt users into marketing.
router.get("/email-preferences", (req, res) => res.json({
  success: true,
  marketing: { enabled: Boolean(req.user.marketingEmailConsent?.enabled), consentAt: req.user.marketingEmailConsent?.consentAt || null },
}));
router.patch("/email-preferences", (0, asyncHandler_js_1.default)(async (req, res) => {
  if (typeof req.body.marketingEnabled !== "boolean") return res.status(400).json({ success: false, message: "marketingEnabled must be boolean" });
  const enabled = req.body.marketingEnabled;
  if (enabled) {
    // Never override provider complaints or all-address suppressions.
    const { isSuppressed } = require("../services/emailService.js");
    const { addressHash } = require("../services/emailCrypto.js");
    if (await isSuppressed(addressHash(req.user.email), "marketing")) return res.status(409).json({ success: false, message: "Email cannot be subscribed while suppressed" });
  }
  const User = require("../models/User.js").default;
  await User.updateOne({ _id: req.user._id }, { $set: {
    "marketingEmailConsent.enabled": enabled,
    ...(enabled ? { "marketingEmailConsent.consentAt": new Date(), "marketingEmailConsent.source": "authenticated_client_preferences", "marketingEmailConsent.unsubscribedAt": null } : { "marketingEmailConsent.unsubscribedAt": new Date() }),
  } });
  return res.json({ success: true, marketing: { enabled } });
}));

router.patch(
  "/account/resubmit",
  uploadMiddleware_js_1.clientRegistrationUpload,
  (0, asyncHandler_js_1.default)(authController_js_1.resubmitRejectedClient),
);
router.get("/account-status", (req, res) => {
  return res.json({
    success: true,
    user: (0, authController_js_1.safeUser)(req.user),
    canAccessBookings: ["active", "verified"].includes(req.user.status),
  });
});
router.get(
  "/rates",
  (0, asyncHandler_js_1.default)(
    billingRateController_js_1.listActiveBillingRates,
  ),
);
router.get(
  "/rate-change-notice",
  (0, asyncHandler_js_1.default)(
    billingRateController_js_1.getClientRateChangeNotice,
  ),
);
router.get(
  "/payment-types",
  (0, asyncHandler_js_1.default)(
    paymentTypeController_js_1.listActivePaymentTypes,
  ),
);
router.get(
  "/notifications",
  (0, asyncHandler_js_1.default)(
    notificationController_js_1.listClientNotifications,
  ),
);
router.patch(
  "/notifications/read-all",
  (0, asyncHandler_js_1.default)(
    notificationController_js_1.markAllNotificationsRead,
  ),
);
router.patch(
  "/notifications/:id/read",
  (0, asyncHandler_js_1.default)(
    notificationController_js_1.markNotificationRead,
  ),
);
router.get(
  "/bookings",
  authMiddleware_js_1.verifiedClientOnly,
  (0, asyncHandler_js_1.default)(bookingController_js_1.listClientBookings),
);
router.post(
  "/bookings",
  authMiddleware_js_1.verifiedClientOnly,
  uploadMiddleware_js_1.bookingPreAdviceUpload,
  (0, asyncHandler_js_1.default)(bookingController_js_1.createClientBooking),
);
router.get(
  "/bookings/:id",
  authMiddleware_js_1.verifiedClientOnly,
  (0, asyncHandler_js_1.default)(bookingController_js_1.getClientBooking),
);
router.patch(
  "/bookings/:id/resubmit",
  authMiddleware_js_1.verifiedClientOnly,
  (0, asyncHandler_js_1.default)(bookingController_js_1.resubmitClientBooking),
);
router.post(
  "/bookings/:id/payment",
  authMiddleware_js_1.verifiedClientOnly,
  uploadMiddleware_js_1.bookingPaymentUpload,
  (0, asyncHandler_js_1.default)(bookingController_js_1.submitBookingPayment),
);
router.post(
  "/bookings/:id/gate-out-request",
  authMiddleware_js_1.verifiedClientOnly,
  (0, asyncHandler_js_1.default)(bookingController_js_1.requestBookingGateOut),
);
router.post(
  "/bookings/:id/gate-out-reversal-request",
  authMiddleware_js_1.verifiedClientOnly,
  (0, asyncHandler_js_1.default)(bookingController_js_1.requestGateOutReversal),
);
router.get(
  "/pre-advices",
  authMiddleware_js_1.verifiedClientOnly,
  (0, asyncHandler_js_1.default)(preAdviceController_js_1.listClientPreAdvices),
);
router.post(
  "/pre-advices",
  authMiddleware_js_1.verifiedClientOnly,
  uploadMiddleware_js_1.preAdviceUpload,
  (0, asyncHandler_js_1.default)(
    preAdviceController_js_1.createClientPreAdvice,
  ),
);
exports.default = router;
