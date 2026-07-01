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
import asyncHandler from "../utils/asyncHandler.js"

const router = express.Router()

router.post("/login", asyncHandler(login))
router.get("/me", protect, asyncHandler(me))

router.post("/forgot-password", asyncHandler(forgotPassword))
router.post("/reset-password", asyncHandler(resetPassword))
router.post("/email/test", asyncHandler(sendTestEmail))

router.post("/client/register/request-otp", clientRegistrationUpload, asyncHandler(requestClientRegistrationOtp))
router.post("/client/register/resend-otp", asyncHandler(resendClientRegistrationOtp))
router.post("/client/register/verify-otp", asyncHandler(verifyClientRegistrationOtp))

export default router
