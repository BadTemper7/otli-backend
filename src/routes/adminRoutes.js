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
} from "../controllers/bookingController.js"
import { adminOnly, protect, requirePermission } from "../middleware/authMiddleware.js"

const router = express.Router()

router.use(protect, adminOnly)

router.get("/users", requirePermission("userManagement", "view"), listUsers)
router.get("/client-registrations", requirePermission("clientVerification", "view"), listClients)
router.get("/users/:id", requirePermission("userManagement", "view"), getUserById)
router.post("/users", requirePermission("userManagement", "create"), createAdminUser)
router.patch("/users/:id", requirePermission("userManagement", "edit"), updateUser)
router.delete("/users/:id", requirePermission("userManagement", "delete"), deleteUser)

router.patch("/clients/:id/approve", requirePermission("clientVerification", "edit"), approveClient)
router.patch("/clients/:id/reject", requirePermission("clientVerification", "edit"), rejectClient)

router.get("/bookings/summary", requirePermission("bookings", "view"), getBookingSummary)
router.get("/bookings", requirePermission("bookings", "view"), listAdminBookings)
router.get("/bookings/yard/blocks/:blockId/slots", requirePermission("bookings", "view"), getYardBlockSlots)
router.get("/pre-advice-bookings", requirePermission("preAdvice", "view"), listAdminBookings)
router.get("/pre-advice-bookings/yard/areas", requirePermission("preAdvice", "view"), listYardAreas)
router.get("/pre-advice-bookings/yard/blocks", requirePermission("preAdvice", "view"), listApprovalYardBlocks)
router.get("/pre-advice-bookings/yard/areas/:areaId/blocks", requirePermission("preAdvice", "view"), listYardBlocks)
router.get("/pre-advice-bookings/yard/blocks/:blockId/slots", requirePermission("preAdvice", "view"), getYardBlockSlots)
router.patch("/pre-advice-bookings/:id/approve", requirePermission("preAdvice", "edit"), approveBooking)
router.patch("/pre-advice-bookings/:id/reject", requirePermission("preAdvice", "edit"), rejectBooking)

router.get("/bookings/:id", requirePermission("bookings", "view"), getAdminBooking)
router.patch("/bookings/:id/approve", requirePermission("bookings", "edit"), approveBooking)
router.patch("/bookings/:id/reject", requirePermission("bookings", "edit"), rejectBooking)
router.patch("/bookings/:id/gate-in", requirePermission("gateIn", "edit"), approveBookingGateIn)
router.patch("/bookings/:id/store", requirePermission("inventory", "edit"), markBookingStored)
router.patch("/bookings/:id/relocate", requirePermission("inventory", "edit"), relocateBooking)
router.patch("/bookings/:id/payment/approve", requirePermission("paymentVerification", "edit"), approveBookingPayment)
router.patch("/bookings/:id/payment/reject", requirePermission("paymentVerification", "edit"), rejectBookingPayment)
router.patch("/bookings/:id/gate-out/approve", requirePermission("gateOut", "edit"), approveBookingGateOut)
router.patch("/bookings/:id/gate-out/complete", requirePermission("gateOut", "edit"), completeBookingGateOut)

router.get("/pre-advices/yard/areas", requirePermission("preAdvice", "view"), listYardAreas)
router.get("/pre-advices/yard/blocks", requirePermission("preAdvice", "view"), listApprovalYardBlocks)
router.get("/pre-advices/yard/areas/:areaId/blocks", requirePermission("preAdvice", "view"), listYardBlocks)
router.get("/pre-advices/yard/blocks/:blockId/slots", requirePermission("preAdvice", "view"), getYardBlockSlots)
router.get("/pre-advices", requirePermission("preAdvice", "view"), listAdminPreAdvices)
router.patch("/pre-advices/:id/confirm", requirePermission("preAdvice", "edit"), confirmPreAdvice)
router.patch("/pre-advices/:id/reject", requirePermission("preAdvice", "edit"), rejectPreAdvice)

router.get("/gate-in/ready", requirePermission("gateIn", "view"), listGateInReadyPreAdvices)
router.post("/gate-in/:preAdviceId/complete", requirePermission("gateIn", "create"), completeGateIn)

router.get("/yard/summary", requirePermission("yardSetup", "view"), getYardSummary)
router.get("/yard/areas", requirePermission("yardSetup", "view"), listYardAreas)
router.post("/yard/areas", requirePermission("yardSetup", "create"), createYardArea)
router.patch("/yard/areas/:id", requirePermission("yardSetup", "edit"), updateYardArea)
router.delete("/yard/areas/:id", requirePermission("yardSetup", "delete"), deleteYardArea)

router.get("/yard/areas/:areaId/blocks", requirePermission("inventory", "view"), listYardBlocks)
router.post("/yard/areas/:areaId/blocks", requirePermission("inventory", "create"), createYardBlock)
router.patch("/yard/blocks/:id", requirePermission("inventory", "edit"), updateYardBlock)
router.delete("/yard/blocks/:id", requirePermission("inventory", "delete"), deleteYardBlock)

router.get("/inventory/containers", requirePermission("inventory", "view"), listInventoryContainers)
router.patch("/inventory/containers/:id/assign", requirePermission("inventory", "edit"), assignInventoryContainer)
router.get("/inventory/summary", requirePermission("inventory", "view"), getYardSummary)
router.get("/inventory/areas", requirePermission("inventory", "view"), listYardAreas)
router.get("/inventory/areas/:areaId/blocks", requirePermission("inventory", "view"), listYardBlocks)
router.get("/inventory/blocks/:blockId/slots", requirePermission("inventory", "view"), getYardBlockSlots)
router.post("/inventory/areas/:areaId/blocks", requirePermission("inventory", "create"), createYardBlock)
router.patch("/inventory/blocks/:id", requirePermission("inventory", "edit"), updateYardBlock)
router.delete("/inventory/blocks/:id", requirePermission("inventory", "delete"), deleteYardBlock)

export default router
