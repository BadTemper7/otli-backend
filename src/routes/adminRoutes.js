import express from "express"
import {
  approveClient,
  createAdminUser,
  deleteUser,
  getUserById,
  listClients,
  listUsers,
  rejectClient,
  updateUser,
} from "../controllers/adminController.js"
import {
  createYardArea,
  createYardBlock,
  deleteYardArea,
  deleteYardBlock,
  getYardSummary,
  listApprovalYardBlocks,
  listYardAreas,
  listYardBlocks,
  updateYardArea,
  updateYardBlock,
} from "../controllers/yardController.js"
import {
  completeGateIn,
  confirmPreAdvice,
  listAdminPreAdvices,
  listGateInReadyPreAdvices,
  rejectPreAdvice,
} from "../controllers/preAdviceController.js"
import { assignInventoryContainer, listInventoryContainers } from "../controllers/inventoryController.js"
import {
  createBillingRate,
  deleteBillingRate,
  listBillingRates,
  seedReferenceBillingRates,
  updateBillingRate,
} from "../controllers/billingRateController.js"

import {
  approveBooking,
  approveBookingGateIn,
  approveBookingGateOut,
  approveBookingPayment,
  completeBookingGateOut,
  getAdminBooking,
  getBookingSummary,
  getYardBlockSlots,
  listAdminBookings,
  markBookingStored,
  relocateBooking,
  rejectBooking,
  rejectBookingPayment,
  updateBookingBillingOperation,
} from "../controllers/bookingController.js"
import { adminOnly, protect, requirePermission } from "../middleware/authMiddleware.js"
import asyncHandler from "../utils/asyncHandler.js"

const router = express.Router()

router.use(protect, adminOnly)

router.get("/users", requirePermission("userManagement", "view"), asyncHandler(listUsers))
router.get("/client-registrations", requirePermission("clientVerification", "view"), asyncHandler(listClients))
router.get("/users/:id", requirePermission("userManagement", "view"), asyncHandler(getUserById))
router.post("/users", requirePermission("userManagement", "create"), asyncHandler(createAdminUser))
router.patch("/users/:id", requirePermission("userManagement", "edit"), asyncHandler(updateUser))
router.delete("/users/:id", requirePermission("userManagement", "delete"), asyncHandler(deleteUser))

router.patch("/clients/:id/approve", requirePermission("clientVerification", "edit"), asyncHandler(approveClient))
router.patch("/clients/:id/reject", requirePermission("clientVerification", "edit"), asyncHandler(rejectClient))

router.get("/bookings/summary", requirePermission("bookings", "view"), asyncHandler(getBookingSummary))
router.get("/bookings", requirePermission("bookings", "view"), asyncHandler(listAdminBookings))
router.get("/bookings/yard/blocks/:blockId/slots", requirePermission("bookings", "view"), asyncHandler(getYardBlockSlots))
router.get("/pre-advice-bookings", requirePermission("preAdvice", "view"), asyncHandler(listAdminBookings))
router.get("/pre-advice-bookings/yard/areas", requirePermission("preAdvice", "view"), asyncHandler(listYardAreas))
router.get("/pre-advice-bookings/yard/blocks", requirePermission("preAdvice", "view"), asyncHandler(listApprovalYardBlocks))
router.get("/pre-advice-bookings/yard/areas/:areaId/blocks", requirePermission("preAdvice", "view"), asyncHandler(listYardBlocks))
router.get("/pre-advice-bookings/yard/blocks/:blockId/slots", requirePermission("preAdvice", "view"), asyncHandler(getYardBlockSlots))
router.patch("/pre-advice-bookings/:id/approve", requirePermission("preAdvice", "edit"), asyncHandler(approveBooking))
router.patch("/pre-advice-bookings/:id/reject", requirePermission("preAdvice", "edit"), asyncHandler(rejectBooking))

router.get("/bookings/:id", requirePermission("bookings", "view"), asyncHandler(getAdminBooking))
router.patch("/bookings/:id/approve", requirePermission("bookings", "edit"), asyncHandler(approveBooking))
router.patch("/bookings/:id/reject", requirePermission("bookings", "edit"), asyncHandler(rejectBooking))
router.patch("/bookings/:id/gate-in", requirePermission("gateIn", "edit"), asyncHandler(approveBookingGateIn))
router.patch("/bookings/:id/store", requirePermission("inventory", "edit"), asyncHandler(markBookingStored))
router.patch("/bookings/:id/billing-operation", requirePermission("inventory", "edit"), asyncHandler(updateBookingBillingOperation))
router.patch("/bookings/:id/relocate", requirePermission("inventory", "edit"), asyncHandler(relocateBooking))
router.patch("/bookings/:id/payment/approve", requirePermission("paymentVerification", "edit"), asyncHandler(approveBookingPayment))
router.patch("/bookings/:id/payment/reject", requirePermission("paymentVerification", "edit"), asyncHandler(rejectBookingPayment))
router.patch("/bookings/:id/gate-out/approve", requirePermission("gateOut", "edit"), asyncHandler(approveBookingGateOut))
router.patch("/bookings/:id/gate-out/complete", requirePermission("gateOut", "edit"), asyncHandler(completeBookingGateOut))

router.get("/billing-rates", requirePermission("rateSetup", "view"), asyncHandler(listBillingRates))
router.post("/billing-rates/reference-defaults", requirePermission("rateSetup", "create"), asyncHandler(seedReferenceBillingRates))
router.post("/billing-rates", requirePermission("rateSetup", "create"), asyncHandler(createBillingRate))
router.patch("/billing-rates/:id", requirePermission("rateSetup", "edit"), asyncHandler(updateBillingRate))
router.delete("/billing-rates/:id", requirePermission("rateSetup", "delete"), asyncHandler(deleteBillingRate))

router.get("/pre-advices/yard/areas", requirePermission("preAdvice", "view"), asyncHandler(listYardAreas))
router.get("/pre-advices/yard/blocks", requirePermission("preAdvice", "view"), asyncHandler(listApprovalYardBlocks))
router.get("/pre-advices/yard/areas/:areaId/blocks", requirePermission("preAdvice", "view"), asyncHandler(listYardBlocks))
router.get("/pre-advices/yard/blocks/:blockId/slots", requirePermission("preAdvice", "view"), asyncHandler(getYardBlockSlots))
router.get("/pre-advices", requirePermission("preAdvice", "view"), asyncHandler(listAdminPreAdvices))
router.patch("/pre-advices/:id/confirm", requirePermission("preAdvice", "edit"), asyncHandler(confirmPreAdvice))
router.patch("/pre-advices/:id/reject", requirePermission("preAdvice", "edit"), asyncHandler(rejectPreAdvice))

router.get("/gate-in/ready", requirePermission("gateIn", "view"), asyncHandler(listGateInReadyPreAdvices))
router.post("/gate-in/:preAdviceId/complete", requirePermission("gateIn", "create"), asyncHandler(completeGateIn))

router.get("/yard/summary", requirePermission("yardSetup", "view"), asyncHandler(getYardSummary))
router.get("/yard/areas", requirePermission("yardSetup", "view"), asyncHandler(listYardAreas))
router.post("/yard/areas", requirePermission("yardSetup", "create"), asyncHandler(createYardArea))
router.patch("/yard/areas/:id", requirePermission("yardSetup", "edit"), asyncHandler(updateYardArea))
router.delete("/yard/areas/:id", requirePermission("yardSetup", "delete"), asyncHandler(deleteYardArea))

router.get("/yard/areas/:areaId/blocks", requirePermission("inventory", "view"), asyncHandler(listYardBlocks))
router.post("/yard/areas/:areaId/blocks", requirePermission("inventory", "create"), asyncHandler(createYardBlock))
router.patch("/yard/blocks/:id", requirePermission("inventory", "edit"), asyncHandler(updateYardBlock))
router.delete("/yard/blocks/:id", requirePermission("inventory", "delete"), asyncHandler(deleteYardBlock))

router.get("/inventory/containers", requirePermission("inventory", "view"), asyncHandler(listInventoryContainers))
router.patch("/inventory/containers/:id/assign", requirePermission("inventory", "edit"), asyncHandler(assignInventoryContainer))
router.get("/inventory/summary", requirePermission("inventory", "view"), asyncHandler(getYardSummary))
router.get("/inventory/areas", requirePermission("inventory", "view"), asyncHandler(listYardAreas))
router.get("/inventory/areas/:areaId/blocks", requirePermission("inventory", "view"), asyncHandler(listYardBlocks))
router.get("/inventory/blocks/:blockId/slots", requirePermission("inventory", "view"), asyncHandler(getYardBlockSlots))
router.post("/inventory/areas/:areaId/blocks", requirePermission("inventory", "create"), asyncHandler(createYardBlock))
router.patch("/inventory/blocks/:id", requirePermission("inventory", "edit"), asyncHandler(updateYardBlock))
router.delete("/inventory/blocks/:id", requirePermission("inventory", "delete"), asyncHandler(deleteYardBlock))

export default router
