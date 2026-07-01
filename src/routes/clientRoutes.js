import express from "express"
import { createClientPreAdvice, listClientPreAdvices } from "../controllers/preAdviceController.js"
import {
  createClientBooking,
  getClientBooking,
  listClientBookings,
  requestBookingGateOut,
  resubmitClientBooking,
  submitBookingPayment,
} from "../controllers/bookingController.js"
import { clientOnly, protect, verifiedClientOnly } from "../middleware/authMiddleware.js"
import { bookingPaymentUpload, preAdviceUpload } from "../middleware/uploadMiddleware.js"
import { safeUser } from "../controllers/authController.js"
import asyncHandler from "../utils/asyncHandler.js"

const router = express.Router()

router.use(protect, clientOnly)

router.get("/account-status", (req, res) => {
  return res.json({
    success: true,
    user: safeUser(req.user),
    canAccessBookings: ["active", "verified"].includes(req.user.status),
  })
})

router.get("/bookings", verifiedClientOnly, asyncHandler(listClientBookings))
router.post("/bookings", verifiedClientOnly, asyncHandler(createClientBooking))
router.get("/bookings/:id", verifiedClientOnly, asyncHandler(getClientBooking))
router.patch("/bookings/:id/resubmit", verifiedClientOnly, asyncHandler(resubmitClientBooking))
router.post("/bookings/:id/payment", verifiedClientOnly, bookingPaymentUpload, asyncHandler(submitBookingPayment))
router.post("/bookings/:id/gate-out-request", verifiedClientOnly, asyncHandler(requestBookingGateOut))

router.get("/pre-advices", verifiedClientOnly, asyncHandler(listClientPreAdvices))
router.post("/pre-advices", verifiedClientOnly, preAdviceUpload, asyncHandler(createClientPreAdvice))

export default router
