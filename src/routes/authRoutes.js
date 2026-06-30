import express from "express"
import {
  forgotPassword,
  login,
  me,
  requestClientRegistrationOtp,
  resendClientRegistrationOtp,
  resetPassword,
  verifyClientRegistrationOtp,
  sendTestEmail,
} from "../controllers/authController.js"
import { protect } from "../middleware/authMiddleware.js"
import { clientRegistrationUpload } from "../middleware/uploadMiddleware.js"

const router = express.Router()

router.post("/login", login)
router.get("/me", protect, me)

router.post("/forgot-password", forgotPassword)
router.post("/reset-password", resetPassword)
router.post("/email/test", sendTestEmail)

router.post("/client/register/request-otp", clientRegistrationUpload, requestClientRegistrationOtp)
router.post("/client/register/resend-otp", resendClientRegistrationOtp)
router.post("/client/register/verify-otp", verifyClientRegistrationOtp)

export default router
