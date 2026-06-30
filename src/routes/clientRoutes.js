import express from "express"
import { createClientPreAdvice, listClientPreAdvices } from "../controllers/preAdviceController.js"
import { createClientBooking, getClientBooking, listClientBookings, requestBookingGateOut, resubmitClientBooking, submitBookingPayment } from "../controllers/bookingController.js"
import { clientOnly, protect, verifiedClientOnly } from "../middleware/authMiddleware.js"
import { bookingPaymentUpload, preAdviceUpload } from "../middleware/uploadMiddleware.js"
import { safeUser } from "../controllers/authController.js"

const router = express.Router()

router.use(protect, clientOnly)

router.get("/account-status", (req, res) => {
  return res.json({
    success: true,
    user: safeUser(req.user),
    canAccessBookings: ["active", "verified"].includes(req.user.status),
  })
})


router.get("/bookings", verifiedClientOnly, listClientBookings)
router.post("/bookings", verifiedClientOnly, createClientBooking)
router.get("/bookings/:id", verifiedClientOnly, getClientBooking)
router.patch("/bookings/:id/resubmit", verifiedClientOnly, resubmitClientBooking)
router.post("/bookings/:id/payment", verifiedClientOnly, bookingPaymentUpload, submitBookingPayment)
router.post("/bookings/:id/gate-out-request", verifiedClientOnly, requestBookingGateOut)

router.get("/pre-advices", verifiedClientOnly, listClientPreAdvices)
router.post("/pre-advices", verifiedClientOnly, preAdviceUpload, createClientPreAdvice)

export default router
