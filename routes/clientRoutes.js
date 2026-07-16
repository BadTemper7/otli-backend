"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
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
const router = express_1.default.Router();
router.use(authMiddleware_js_1.protect, authMiddleware_js_1.clientOnly);
router.get("/account-status", (req, res) => {
    return res.json({
        success: true,
        user: (0, authController_js_1.safeUser)(req.user),
        canAccessBookings: ["active", "verified"].includes(req.user.status),
    });
});
router.get("/rates", (0, asyncHandler_js_1.default)(billingRateController_js_1.listActiveBillingRates));
router.get("/payment-types", (0, asyncHandler_js_1.default)(paymentTypeController_js_1.listActivePaymentTypes));
router.get("/bookings", authMiddleware_js_1.verifiedClientOnly, (0, asyncHandler_js_1.default)(bookingController_js_1.listClientBookings));
router.post("/bookings", authMiddleware_js_1.verifiedClientOnly, uploadMiddleware_js_1.bookingPreAdviceUpload, (0, asyncHandler_js_1.default)(bookingController_js_1.createClientBooking));
router.get("/bookings/:id", authMiddleware_js_1.verifiedClientOnly, (0, asyncHandler_js_1.default)(bookingController_js_1.getClientBooking));
router.patch("/bookings/:id/resubmit", authMiddleware_js_1.verifiedClientOnly, (0, asyncHandler_js_1.default)(bookingController_js_1.resubmitClientBooking));
router.post("/bookings/:id/payment", authMiddleware_js_1.verifiedClientOnly, uploadMiddleware_js_1.bookingPaymentUpload, (0, asyncHandler_js_1.default)(bookingController_js_1.submitBookingPayment));
router.post("/bookings/:id/gate-out-request", authMiddleware_js_1.verifiedClientOnly, (0, asyncHandler_js_1.default)(bookingController_js_1.requestBookingGateOut));
router.get("/pre-advices", authMiddleware_js_1.verifiedClientOnly, (0, asyncHandler_js_1.default)(preAdviceController_js_1.listClientPreAdvices));
router.post("/pre-advices", authMiddleware_js_1.verifiedClientOnly, uploadMiddleware_js_1.preAdviceUpload, (0, asyncHandler_js_1.default)(preAdviceController_js_1.createClientPreAdvice));
exports.default = router;
