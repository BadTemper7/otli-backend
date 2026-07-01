import Booking from "../models/Booking.js"
import PreAdvice from "../models/PreAdvice.js"
import InventoryContainer from "../models/InventoryContainer.js"
import YardArea from "../models/YardArea.js"
import YardBlock from "../models/YardBlock.js"
import { uploadBufferToCloudinary } from "../config/cloudinary.js"
import { sendEmail } from "../config/mailer.js"
import { bookingStatusEmailTemplate } from "../utils/emailTemplates.js"
import { emitToAdmins, emitToUser } from "../socket/socket.js"
import { buildBookingNumber } from "../utils/bookingNumber.js"

const ACTIVE_BOOKING_STATUSES = [
  "approved_area_assigned",
  "gate_in_approved",
  "stored_in_assigned_area",
  "gate_out_requested",
  "gate_out_approved",
]

const TERMINAL_BOOKING_STATUSES = ["rejected", "cancelled", "completed_gate_out_done"]

const normalizeContainerNumber = (value = "") => String(value).toUpperCase().replace(/[^A-Z0-9]/g, "").trim()
const isValidContainerNumber = (value = "") => /^[A-Z]{4}\d{7}$/.test(normalizeContainerNumber(value))
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
const toPositive = (value, fallback = 1) => Math.max(toNumber(value, fallback), 1)
const getTeuFactor = (size) => {
  if (Number(size) === 40) return 2
  if (Number(size) === 45) return 2.25
  return 1
}

const calculateAreaCapacityTeu = ({ lineCount = 1, rowCount = 1, tierCount = 1, containerSize = 20 }) => {
  const capacity = toPositive(lineCount, 1) * toPositive(rowCount, 1) * toPositive(tierCount, 1) * getTeuFactor(containerSize)
  return Math.max(Math.round(capacity * 100) / 100, 1)
}

const ensureAreaLocationBlock = async (area) => {
  const existingBlock = await YardBlock.findOne({ area: area._id }).sort({ sortOrder: 1, code: 1, name: 1 })
  if (existingBlock) return existingBlock

  const lineCount = toPositive(area.lineCount, 1)
  const rowCount = toPositive(area.rowCount, 1)
  const tierCount = toPositive(area.tierCount, 1)
  const containerSize = [20, 40, 45].includes(Number(area.containerSize)) ? Number(area.containerSize) : 20
  const capacityTeu = area.capacityTeu || calculateAreaCapacityTeu({ lineCount, rowCount, tierCount, containerSize })

  return YardBlock.create({
    area: area._id,
    name: area.name,
    code: area.code,
    blockType: "standard",
    bayCount: lineCount,
    rowCount,
    tierCount,
    containerSize,
    teuSlots: Math.max(Number(capacityTeu) || 1, 1),
    occupiedSlots: 0,
    status: area.status === "active" ? "active" : area.status === "maintenance" ? "maintenance" : "inactive",
    notes: "Internal location record created from the yard area for bay, row, and tier tracking.",
  })
}

const bookingDocumentLabels = {
  paymentProof: "Payment Proof",
  otherDocument: "Other Document",
}

const buildSequenceNumber = async (prefix, Model, fieldName) => {
  const today = new Date()
  const yyyy = today.getFullYear()
  const mm = String(today.getMonth() + 1).padStart(2, "0")
  const dd = String(today.getDate()).padStart(2, "0")
  const dateCode = `${yyyy}${mm}${dd}`
  const dayStart = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`)
  const count = await Model.countDocuments({ createdAt: { $gte: dayStart } })
  const seq = String(count + 1).padStart(5, "0")
  const value = `${prefix}-${dateCode}-${seq}`
  const exists = await Model.findOne({ [fieldName]: value })
  if (!exists) return value
  return `${value}-${Date.now().toString().slice(-4)}`
}

const getClientDisplayName = (client = {}) => client.companyName || client.name || "Client"

const getClientPortalUrl = () => {
  if (process.env.CLIENT_PUBLIC_URL) return process.env.CLIENT_PUBLIC_URL.replace(/\/$/, "")
  const firstOrigin = String(process.env.CLIENT_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean)[0]
  return (firstOrigin || "http://localhost:5173").replace(/\/$/, "")
}

const getBookingTrackingUrl = (bookingNumber = "") => {
  const encoded = encodeURIComponent(String(bookingNumber || "").trim())
  return `${getClientPortalUrl()}/booking-status${encoded ? `?bookingNumber=${encoded}` : ""}`
}

const addHistory = (booking, { status = booking.status, billingStatus = booking.billingStatus, remarks = "", changedBy = null }) => {
  booking.statusHistory.push({ status, billingStatus, remarks, changedBy, changedAt: new Date() })
}

const populateBooking = (query) => {
  return query
    .populate("client", "name email companyName phoneNumber")
    .populate("assignedArea", "name code")
    .populate("assignedBlock", "name code teuSlots occupiedSlots bayCount rowCount tierCount containerSize")
}

const safeBooking = (booking) => {
  const doc = booking.toObject ? booking.toObject() : booking
  const client = doc.client || {}
  const area = doc.assignedArea || null
  const block = doc.assignedBlock || null

  return {
    id: String(doc._id),
    client: client?._id ? String(client._id) : String(doc.client),
    clientName: getClientDisplayName(client),
    clientEmail: client.email || "",
    clientPhoneNumber: client.phoneNumber || "",
    bookingReference: doc.bookingReference,
    containerNumber: doc.containerNumber,
    containerSize: Number(doc.containerSize),
    containerType: doc.containerType,
    containerLoadStatus: doc.containerLoadStatus,
    shippingLine: doc.shippingLine,
    bookingNumber: doc.bookingNumber || "",
    qrCodeValue: doc.qrCodeValue || "",
    blNumber: doc.blNumber || "",
    vesselVoyage: doc.vesselVoyage || "",
    cargoDescription: doc.cargoDescription || "",
    weight: Number(doc.weight) || 0,
    expectedArrivalDate: doc.expectedArrivalDate,
    clientRemarks: doc.clientRemarks || "",
    status: doc.status,
    billingStatus: doc.billingStatus,
    rejectionReason: doc.rejectionReason || "",
    assignedArea: area?._id ? String(area._id) : doc.assignedArea ? String(doc.assignedArea) : "",
    assignedAreaName: area?.name || "",
    assignedAreaCode: area?.code || "",
    assignedBlock: block?._id ? String(block._id) : doc.assignedBlock ? String(doc.assignedBlock) : "",
    assignedBlockName: block?.name || "",
    assignedBlockCode: block?.code || "",
    assignedBay: Number(doc.assignedBay) || 1,
    assignedRow: Number(doc.assignedRow) || 1,
    assignedTier: Number(doc.assignedTier) || 1,
    assignedSlotNumber: doc.assignedSlotNumber || "",
    approvedAt: doc.approvedAt,
    gateInApprovedAt: doc.gateInApprovedAt,
    actualContainerNumber: doc.actualContainerNumber || "",
    physicalCondition: doc.physicalCondition || "",
    sealNumber: doc.sealNumber || "",
    truckPlateNumber: doc.truckPlateNumber || "",
    driverName: doc.driverName || "",
    driverLicenseNumber: doc.driverLicenseNumber || "",
    inspectionRemarks: doc.inspectionRemarks || "",
    storedAt: doc.storedAt,
    storageStartDate: doc.storageStartDate,
    paymentAmount: Number(doc.paymentAmount) || 0,
    paymentReferenceNumber: doc.paymentReferenceNumber || "",
    paymentDate: doc.paymentDate,
    paymentRemarks: doc.paymentRemarks || "",
    paymentProofs: doc.paymentProofs || [],
    paymentSubmittedAt: doc.paymentSubmittedAt,
    paymentRejectionReason: doc.paymentRejectionReason || "",
    gateOutRequestedAt: doc.gateOutRequestedAt,
    gateOutRequestRemarks: doc.gateOutRequestRemarks || "",
    gateOutApprovedAt: doc.gateOutApprovedAt,
    gateOutRemarks: doc.gateOutRemarks || "",
    releasedAt: doc.releasedAt,
    releaseRemarks: doc.releaseRemarks || "",
    statusHistory: doc.statusHistory || [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

const notifyEmail = async ({ to, subject, title, booking, message, details = [], qrCodeValue = "", trackingUrl = "" }) => {
  if (!to) return

  try {
    await sendEmail({
      to,
      subject,
      html: bookingStatusEmailTemplate({
        title,
        reference: booking.bookingReference,
        status: booking.status,
        billingStatus: booking.billingStatus,
        message,
        details,
        qrCodeValue,
        trackingUrl,
      }),
      text: `${title}\n${message}\nBooking: ${booking.bookingReference}\nStatus: ${booking.status}\nBilling: ${booking.billingStatus}`,
    })
  } catch (error) {
    console.error("[booking-email] failed", { to, subject, error: error.message })
  }
}

const notifyClient = async (booking, title, message, details = [], options = {}) => {
  const populated = booking.client?.email ? booking : await booking.populate("client", "name email companyName")
  await notifyEmail({
    to: populated.client?.email,
    subject: `${title} - ${populated.bookingReference}`,
    title,
    booking: populated,
    message,
    details,
    qrCodeValue: options.qrCodeValue || populated.qrCodeValue || "",
    trackingUrl: options.trackingUrl || "",
  })
}

const notifyAdmin = async (booking, title, message, details = []) => {
  const adminEmail = process.env.SUPER_ADMIN_EMAIL
  if (!adminEmail) return
  await notifyEmail({
    to: adminEmail,
    subject: `${title} - ${booking.bookingReference}`,
    title,
    booking,
    message,
    details,
  })
}

const uploadBookingPaymentDocuments = async ({ files, bookingReference }) => {
  const uploadedDocs = []

  for (const fieldName of Object.keys(bookingDocumentLabels)) {
    const list = files?.[fieldName] || []
    for (const file of list) {
      const result = await uploadBufferToCloudinary({
        file,
        folder: `${process.env.CLOUDINARY_FOLDER || "otli-documents"}/booking-payments`,
        publicIdPrefix: `${bookingReference}-${fieldName}-${Date.now()}`,
      })

      uploadedDocs.push({
        type: fieldName,
        label: bookingDocumentLabels[fieldName],
        fileName: file.originalname,
        url: result.url,
        secureUrl: result.secure_url,
        publicId: result.public_id,
        resourceType: result.resource_type || "auto",
        mimeType: file.mimetype,
        sizeBytes: file.size,
        uploadedAt: new Date(),
      })
    }
  }

  return uploadedDocs
}

const activeBookingFilterForBlock = (blockId) => ({
  assignedBlock: blockId,
  status: { $in: ACTIVE_BOOKING_STATUSES },
})

const recalculateBlockOccupancy = async (blockId) => {
  if (!blockId) return

  const [inventoryContainers, bookingContainers] = await Promise.all([
    InventoryContainer.find({ block: blockId, status: { $ne: "released" } }).select("containerSize"),
    Booking.find(activeBookingFilterForBlock(blockId)).select("containerSize"),
  ])

  const occupied = [...inventoryContainers, ...bookingContainers].reduce((total, item) => total + getTeuFactor(item.containerSize), 0)

  await YardBlock.findByIdAndUpdate(blockId, {
    occupiedSlots: Math.round(occupied * 100) / 100,
  })
}

const validateYardAssignment = async ({ areaId, blockId, bay, row, tier, containerSize, bookingId }) => {
  if (!areaId) {
    const error = new Error("Select yard area before approving the booking.")
    error.statusCode = 400
    throw error
  }

  const area = await YardArea.findById(areaId)

  if (!area) {
    const error = new Error("Selected yard area was not found.")
    error.statusCode = 404
    throw error
  }

  if (area.status !== "active") {
    const error = new Error("Only active yard areas can be selected.")
    error.statusCode = 400
    throw error
  }

  const block = blockId ? await YardBlock.findById(blockId) : await ensureAreaLocationBlock(area)

  if (!block || String(block.area) !== String(area._id)) {
    const error = new Error("Selected yard area location was not found.")
    error.statusCode = 404
    throw error
  }

  if (block.status !== "active") {
    const error = new Error("Only active yard areas can be selected.")
    error.statusCode = 400
    throw error
  }

  // Yard Area is the user-facing location assignment. The backend uses one internal
  // location record per area so bay, row, and tier availability can still be tracked.

  const nextBay = toPositive(bay, 1)
  const nextRow = toPositive(row, 1)
  const nextTier = toPositive(tier, 1)

  if (nextBay > block.bayCount || nextRow > block.rowCount || nextTier > block.tierCount) {
    const error = new Error(`Location is outside yard area limits. Max bay ${block.bayCount}, row ${block.rowCount}, tier ${block.tierCount}.`)
    error.statusCode = 400
    throw error
  }

  const occupiedInventorySlot = await InventoryContainer.findOne({
    block: block._id,
    bay: nextBay,
    row: nextRow,
    tier: nextTier,
    status: { $ne: "released" },
  })

  if (occupiedInventorySlot) {
    const error = new Error("That bay, row, and tier is already occupied in inventory.")
    error.statusCode = 409
    throw error
  }

  const reservedBookingSlot = await Booking.findOne({
    _id: { $ne: bookingId },
    assignedBlock: block._id,
    assignedBay: nextBay,
    assignedRow: nextRow,
    assignedTier: nextTier,
    status: { $nin: TERMINAL_BOOKING_STATUSES },
  })

  if (reservedBookingSlot) {
    const error = new Error("That bay, row, and tier is already reserved by another active booking.")
    error.statusCode = 409
    throw error
  }

  const [inventoryContainers, bookingContainers] = await Promise.all([
    InventoryContainer.find({ block: block._id, status: { $ne: "released" } }).select("containerSize"),
    Booking.find({ _id: { $ne: bookingId }, assignedBlock: block._id, status: { $nin: TERMINAL_BOOKING_STATUSES } }).select("containerSize"),
  ])

  const usedTeu = [...inventoryContainers, ...bookingContainers].reduce((total, item) => total + getTeuFactor(item.containerSize), 0)
  const containerTeu = getTeuFactor(containerSize)

  return {
    area,
    block,
    bay: nextBay,
    row: nextRow,
    tier: nextTier,
    slotNumber: `${block.code}-B${nextBay}-R${nextRow}-T${nextTier}`,
    remainingAfterApproval: Math.max(Number(block.teuSlots) - usedTeu - containerTeu, 0),
  }
}


const getSlotKey = (bay, row, tier) => `${bay}-${row}-${tier}`

export const getYardBlockSlots = async (req, res) => {
  const block = await YardBlock.findById(req.params.blockId).populate("area", "name code")

  if (!block) {
    return res.status(404).json({ success: false, message: "Yard block not found." })
  }

  const [inventorySlots, bookingSlots, preAdviceSlots] = await Promise.all([
    InventoryContainer.find({ block: block._id, status: { $ne: "released" } }).select("containerNumber bay row tier status"),
    Booking.find({ assignedBlock: block._id, status: { $nin: TERMINAL_BOOKING_STATUSES } }).select("bookingReference containerNumber assignedBay assignedRow assignedTier status"),
    PreAdvice.find({ plannedBlock: block._id, status: "confirmed" }).select("preAdviceNumber containerNumber plannedBay plannedRow plannedTier status"),
  ])

  const slots = [
    ...inventorySlots.map((item) => ({
      key: getSlotKey(item.bay, item.row, item.tier),
      bay: Number(item.bay) || 1,
      row: Number(item.row) || 1,
      tier: Number(item.tier) || 1,
      type: "occupied",
      status: item.status,
      containerNumber: item.containerNumber,
      reference: item.containerNumber,
    })),
    ...bookingSlots.map((item) => ({
      key: getSlotKey(item.assignedBay, item.assignedRow, item.assignedTier),
      bay: Number(item.assignedBay) || 1,
      row: Number(item.assignedRow) || 1,
      tier: Number(item.assignedTier) || 1,
      type: item.status === "stored_in_assigned_area" ? "occupied" : "reserved",
      status: item.status,
      containerNumber: item.containerNumber,
      reference: item.bookingReference,
    })),
    ...preAdviceSlots.map((item) => ({
      key: getSlotKey(item.plannedBay, item.plannedRow, item.plannedTier),
      bay: Number(item.plannedBay) || 1,
      row: Number(item.plannedRow) || 1,
      tier: Number(item.plannedTier) || 1,
      type: "reserved",
      status: item.status,
      containerNumber: item.containerNumber,
      reference: item.preAdviceNumber,
    })),
  ]

  return res.json({
    success: true,
    block: {
      id: String(block._id),
      area: block.area?._id ? String(block.area._id) : String(block.area),
      areaName: block.area?.name || "",
      name: block.name,
      code: block.code,
      bayCount: Number(block.bayCount) || 1,
      rowCount: Number(block.rowCount) || 1,
      tierCount: Number(block.tierCount) || 1,
      containerSize: Number(block.containerSize) || 20,
      teuSlots: Number(block.teuSlots) || 0,
      occupiedSlots: Number(block.occupiedSlots) || 0,
      availableSlots: Math.max((Number(block.teuSlots) || 0) - (Number(block.occupiedSlots) || 0), 0),
    },
    slots,
  })
}

const handleValidationError = (error, res) => {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message })
  throw error
}

export const createClientBooking = async (req, res) => {
  const {
    containerNumber,
    containerSize,
    containerType,
    containerLoadStatus,
    shippingLine,
    truckPlateNumber,
    driverName,
    driverLicenseNumber,
    blNumber,
    vesselVoyage,
    cargoDescription,
    weight,
    expectedArrivalDate,
    clientRemarks,
  } = req.body

  const requiredFields = [containerNumber, containerSize, containerType, shippingLine, expectedArrivalDate, truckPlateNumber, driverName]
  if (requiredFields.some((value) => !String(value || "").trim())) {
    return res.status(400).json({ success: false, message: "Please complete all required booking fields." })
  }

  const normalizedContainer = normalizeContainerNumber(containerNumber)
  if (!isValidContainerNumber(normalizedContainer)) {
    return res.status(400).json({ success: false, message: "Container number must follow the format ABCD1234567." })
  }

  const activeDuplicate = await Booking.findOne({
    containerNumber: normalizedContainer,
    status: { $nin: TERMINAL_BOOKING_STATUSES },
  })

  if (activeDuplicate) {
    return res.status(409).json({ success: false, message: "This container already has an active booking." })
  }

  const inInventory = await InventoryContainer.findOne({
    containerNumber: normalizedContainer,
    status: { $ne: "released" },
  })

  if (inInventory) {
    return res.status(409).json({ success: false, message: "This container is already in active inventory." })
  }

  const bookingReference = await buildSequenceNumber("BK", Booking, "bookingReference")

  const booking = await Booking.create({
    client: req.user._id,
    bookingReference,
    containerNumber: normalizedContainer,
    containerSize: Number(containerSize),
    containerType,
    containerLoadStatus: containerLoadStatus || "empty",
    shippingLine,
    truckPlateNumber: truckPlateNumber || "",
    driverName: driverName || "",
    driverLicenseNumber: driverLicenseNumber || "",
    blNumber: blNumber || "",
    vesselVoyage: vesselVoyage || "",
    cargoDescription: cargoDescription || "",
    weight: Number(weight) || 0,
    expectedArrivalDate,
    clientRemarks: clientRemarks || "",
    status: "pending_admin_approval",
    billingStatus: "unpaid",
    submittedAt: new Date(),
    statusHistory: [
      {
        status: "pending_admin_approval",
        billingStatus: "unpaid",
        remarks: "Booking submitted by client.",
        changedBy: req.user._id,
        changedAt: new Date(),
      },
    ],
  })

  await booking.populate("client", "name email companyName phoneNumber")
  const payload = safeBooking(booking)

  emitToAdmins("booking:submitted", payload)
  emitToUser(req.user._id, "booking:submitted", payload)

  await notifyClient(booking, "Booking request received", "Your booking request has been received and is now waiting for admin approval.", [
    { label: "Container", value: booking.containerNumber },
    { label: "Container Size", value: `${booking.containerSize}ft` },
  ])
  await notifyAdmin(booking, "New booking request", "A client submitted a new booking request for admin review.", [
    { label: "Client", value: getClientDisplayName(booking.client) },
    { label: "Container", value: booking.containerNumber },
  ])

  return res.status(201).json({ success: true, message: "Booking submitted. Please wait for admin approval.", booking: payload })
}

export const resubmitClientBooking = async (req, res) => {
  const booking = await Booking.findOne({ _id: req.params.id, client: req.user._id })
  if (!booking) return res.status(404).json({ success: false, message: "Booking not found." })

  if (booking.status !== "rejected") {
    return res.status(400).json({ success: false, message: "Only rejected bookings can be resubmitted." })
  }

  const {
    containerNumber,
    containerSize,
    containerType,
    containerLoadStatus,
    shippingLine,
    truckPlateNumber,
    driverName,
    driverLicenseNumber,
    blNumber,
    vesselVoyage,
    cargoDescription,
    weight,
    expectedArrivalDate,
    clientRemarks,
  } = req.body

  const requiredFields = [containerNumber, containerSize, containerType, shippingLine, expectedArrivalDate, truckPlateNumber, driverName]
  if (requiredFields.some((value) => !String(value || "").trim())) {
    return res.status(400).json({ success: false, message: "Please complete all required booking fields before resubmitting." })
  }

  const normalizedContainer = normalizeContainerNumber(containerNumber)
  if (!isValidContainerNumber(normalizedContainer)) {
    return res.status(400).json({ success: false, message: "Container number must follow the format ABCD1234567." })
  }

  const activeDuplicate = await Booking.findOne({
    _id: { $ne: booking._id },
    containerNumber: normalizedContainer,
    status: { $nin: TERMINAL_BOOKING_STATUSES },
  })

  if (activeDuplicate) {
    return res.status(409).json({ success: false, message: "This container already has another active booking." })
  }

  const previousBlockId = booking.assignedBlock ? String(booking.assignedBlock) : ""

  booking.containerNumber = normalizedContainer
  booking.containerSize = Number(containerSize)
  booking.containerType = containerType
  booking.containerLoadStatus = containerLoadStatus || "empty"
  booking.shippingLine = shippingLine
  booking.truckPlateNumber = truckPlateNumber || ""
  booking.driverName = driverName || ""
  booking.driverLicenseNumber = driverLicenseNumber || ""
  booking.blNumber = blNumber || ""
  booking.vesselVoyage = vesselVoyage || ""
  booking.cargoDescription = cargoDescription || ""
  booking.weight = Number(weight) || 0
  booking.expectedArrivalDate = expectedArrivalDate
  booking.clientRemarks = clientRemarks || ""
  booking.status = "pending_admin_approval"
  booking.rejectionReason = ""
  booking.assignedArea = null
  booking.assignedBlock = null
  booking.assignedBay = 1
  booking.assignedRow = 1
  booking.assignedTier = 1
  booking.assignedSlotNumber = ""
  booking.assignedAt = null
  booking.assignedBy = null
  booking.approvedAt = null
  booking.approvedBy = null
  addHistory(booking, { remarks: "Booking resubmitted by client. Yard location must be reassigned by admin.", changedBy: req.user._id })

  await booking.save()
  if (previousBlockId) await recalculateBlockOccupancy(previousBlockId)

  await booking.populate("client", "name email companyName phoneNumber")
  const payload = safeBooking(booking)

  emitToAdmins("booking:resubmitted", payload)
  emitToUser(req.user._id, "booking:resubmitted", payload)
  emitToAdmins("yard:slot_released", { bookingId: payload.id, previousBlockId })

  await notifyClient(booking, "Booking resubmitted", "Your booking has been resubmitted and is waiting for admin approval again.", [
    { label: "Container", value: booking.containerNumber },
    { label: "Status", value: "Pending Admin Approval" },
  ])
  await notifyAdmin(booking, "Booking resubmitted", "A client resubmitted a rejected booking. Admin must review and assign a yard location again.", [
    { label: "Client", value: getClientDisplayName(booking.client) },
    { label: "Container", value: booking.containerNumber },
  ])

  return res.json({ success: true, message: "Booking resubmitted. Please wait for admin approval.", booking: payload })
}

export const listClientBookings = async (req, res) => {
  const bookings = await populateBooking(Booking.find({ client: req.user._id })).sort({ createdAt: -1 })
  return res.json({ success: true, bookings: bookings.map(safeBooking) })
}

export const getClientBooking = async (req, res) => {
  const booking = await populateBooking(Booking.findOne({ _id: req.params.id, client: req.user._id }))
  if (!booking) return res.status(404).json({ success: false, message: "Booking not found." })
  return res.json({ success: true, booking: safeBooking(booking) })
}

export const listAdminBookings = async (req, res) => {
  const { status, billingStatus, search } = req.query
  const query = {}

  if (status && status !== "all") query.status = status
  if (billingStatus && billingStatus !== "all") query.billingStatus = billingStatus
  if (search) {
    const term = String(search).trim()
    query.$or = [
      { bookingReference: { $regex: term, $options: "i" } },
      { bookingNumber: { $regex: term, $options: "i" } },
      { containerNumber: { $regex: term, $options: "i" } },
      { shippingLine: { $regex: term, $options: "i" } },
    ]
  }

  const bookings = await populateBooking(Booking.find(query)).sort({ createdAt: -1 }).limit(300)
  return res.json({ success: true, bookings: bookings.map(safeBooking) })
}

export const getAdminBooking = async (req, res) => {
  const booking = await populateBooking(Booking.findById(req.params.id))
  if (!booking) return res.status(404).json({ success: false, message: "Booking not found." })
  return res.json({ success: true, booking: safeBooking(booking) })
}

export const approveBooking = async (req, res) => {
  const booking = await Booking.findById(req.params.id)
  if (!booking) return res.status(404).json({ success: false, message: "Booking not found." })

  if (!["pending_admin_approval", "rejected", "approved_area_assigned"].includes(booking.status)) {
    return res.status(400).json({ success: false, message: `Booking cannot be approved from ${booking.status}.` })
  }

  let plan
  try {
    plan = await validateYardAssignment({
      areaId: req.body.areaId,
      blockId: req.body.blockId,
      bay: req.body.bay,
      row: req.body.row,
      tier: req.body.tier,
      containerSize: booking.containerSize,
      bookingId: booking._id,
    })
  } catch (error) {
    return handleValidationError(error, res)
  }

  const previousBlockId = booking.assignedBlock ? String(booking.assignedBlock) : ""

  if (!booking.bookingNumber) {
    booking.bookingNumber = await buildBookingNumber()
  }

  booking.qrCodeValue = `OTLI:BOOKING:${booking.bookingNumber}:${booking.containerNumber}`

  booking.status = "approved_area_assigned"
  booking.rejectionReason = ""
  booking.approvedAt = new Date()
  booking.approvedBy = req.user._id
  booking.assignedArea = plan.area._id
  booking.assignedBlock = plan.block._id
  booking.assignedBay = plan.bay
  booking.assignedRow = plan.row
  booking.assignedTier = plan.tier
  booking.assignedSlotNumber = plan.slotNumber
  booking.assignedAt = new Date()
  booking.assignedBy = req.user._id
  addHistory(booking, { remarks: "Booking approved and yard area assigned.", changedBy: req.user._id })

  await booking.save()
  await recalculateBlockOccupancy(plan.block._id)
  if (previousBlockId && previousBlockId !== String(plan.block._id)) await recalculateBlockOccupancy(previousBlockId)

  await booking.populate("client", "name email companyName phoneNumber")
  await booking.populate("assignedArea", "name code")
  await booking.populate("assignedBlock", "name code teuSlots occupiedSlots bayCount rowCount tierCount containerSize")

  const payload = safeBooking(booking)
  emitToAdmins("booking:approved", payload)
  emitToAdmins("yard:slot_reserved", payload)
  emitToAdmins("inventory:updated", payload)
  emitToUser(booking.client?._id || booking.client, "booking:approved", payload)

  await notifyClient(booking, "Booking approved and QR generated", "Your booking was approved. A booking number and QR value have been generated. Use the tracking page to view the latest status.", [
    { label: "Booking Number", value: booking.bookingNumber },
    { label: "Container", value: booking.containerNumber },
    { label: "Driver", value: booking.driverName },
    { label: "Truck Plate", value: booking.truckPlateNumber },
    { label: "Assigned Area", value: payload.assignedAreaName },
    { label: "Slot", value: payload.assignedSlotNumber },
    { label: "Tracking Page", value: getBookingTrackingUrl(booking.bookingNumber) },
  ], {
    qrCodeValue: booking.qrCodeValue,
    trackingUrl: getBookingTrackingUrl(booking.bookingNumber),
  })

  return res.json({ success: true, message: "Booking approved and yard area assigned.", booking: payload })
}

export const rejectBooking = async (req, res) => {
  const { reason } = req.body
  const booking = await Booking.findById(req.params.id)
  if (!booking) return res.status(404).json({ success: false, message: "Booking not found." })

  if (!String(reason || "").trim()) {
    return res.status(400).json({ success: false, message: "Rejection reason is required." })
  }

  if (!["pending_admin_approval", "approved_area_assigned", "rejected"].includes(booking.status)) {
    return res.status(400).json({ success: false, message: `Booking cannot be rejected from ${booking.status}.` })
  }

  const previousBlockId = booking.assignedBlock ? String(booking.assignedBlock) : ""

  booking.status = "rejected"
  booking.rejectionReason = reason
  booking.assignedArea = null
  booking.assignedBlock = null
  booking.assignedBay = 1
  booking.assignedRow = 1
  booking.assignedTier = 1
  booking.assignedSlotNumber = ""
  booking.assignedAt = null
  booking.assignedBy = null
  booking.approvedAt = null
  booking.approvedBy = null
  addHistory(booking, { remarks: `Booking rejected: ${reason}. Yard slot released.`, changedBy: req.user._id })

  await booking.save()
  if (previousBlockId) await recalculateBlockOccupancy(previousBlockId)
  await booking.populate("client", "name email companyName phoneNumber")

  const payload = safeBooking(booking)
  emitToAdmins("booking:rejected", payload)
  emitToAdmins("yard:slot_released", { ...payload, previousBlockId })
  emitToAdmins("inventory:updated", payload)
  emitToUser(booking.client?._id || booking.client, "booking:rejected", payload)

  await notifyClient(booking, "Booking rejected", "Your booking was rejected. Please review the reason and contact OTLI if you need assistance.", [
    { label: "Reason", value: reason },
  ])

  return res.json({ success: true, message: "Booking rejected.", booking: payload })
}

export const approveBookingGateIn = async (req, res) => {
  const booking = await Booking.findById(req.params.id)
  if (!booking) return res.status(404).json({ success: false, message: "Booking not found." })

  if (booking.status !== "approved_area_assigned") {
    return res.status(400).json({ success: false, message: "Only approved bookings with assigned area can be approved for Gate-In." })
  }

  if (!booking.assignedArea || !booking.assignedBlock) {
    return res.status(400).json({ success: false, message: "Booking has no assigned yard area." })
  }

  const actualContainerNumber = normalizeContainerNumber(req.body.actualContainerNumber || booking.containerNumber)
  if (actualContainerNumber !== booking.containerNumber) {
    return res.status(400).json({ success: false, message: "Actual container number must match the approved booking." })
  }

  if (!booking.truckPlateNumber || !booking.driverName) {
    return res.status(400).json({ success: false, message: "Truck plate number and driver name must be added in the booking before Gate-In." })
  }

  booking.status = "gate_in_approved"
  booking.gateInApprovedAt = new Date()
  booking.gateInApprovedBy = req.user._id
  booking.actualContainerNumber = actualContainerNumber
  booking.physicalCondition = req.body.physicalCondition || "Good"
  booking.sealNumber = req.body.sealNumber || ""
  booking.truckPlateNumber = booking.truckPlateNumber || req.body.truckPlateNumber || ""
  booking.driverName = booking.driverName || req.body.driverName || ""
  booking.driverLicenseNumber = booking.driverLicenseNumber || req.body.driverLicenseNumber || ""
  booking.inspectionRemarks = req.body.inspectionRemarks || ""
  addHistory(booking, { remarks: "Gate-In approved after inspection.", changedBy: req.user._id })

  await booking.save()
  await booking.populate("client", "name email companyName phoneNumber")
  await booking.populate("assignedArea", "name code")
  await booking.populate("assignedBlock", "name code")

  const payload = safeBooking(booking)
  emitToAdmins("booking:gate_in_approved", payload)
  emitToUser(booking.client?._id || booking.client, "booking:gate_in_approved", payload)

  await notifyClient(booking, "Gate-In approved", "Your container has entered the yard gate and passed inspection.", [
    { label: "Container", value: booking.containerNumber },
    { label: "Truck Plate", value: booking.truckPlateNumber },
  ])

  return res.json({ success: true, message: "Gate-In approved.", booking: payload })
}

export const markBookingStored = async (req, res) => {
  const booking = await Booking.findById(req.params.id)
  if (!booking) return res.status(404).json({ success: false, message: "Booking not found." })

  if (!["gate_in_approved", "stored_in_assigned_area"].includes(booking.status)) {
    return res.status(400).json({ success: false, message: "Only gate-in approved bookings can be marked as stored." })
  }

  booking.status = "stored_in_assigned_area"
  booking.storedAt = new Date()
  booking.storedBy = req.user._id
  booking.storageStartDate = booking.storageStartDate || new Date()
  addHistory(booking, { remarks: "Container stored in assigned yard location.", changedBy: req.user._id })

  await booking.save()
  await recalculateBlockOccupancy(booking.assignedBlock)
  await booking.populate("client", "name email companyName phoneNumber")
  await booking.populate("assignedArea", "name code")
  await booking.populate("assignedBlock", "name code")

  const payload = safeBooking(booking)
  emitToAdmins("booking:stored", payload)
  emitToAdmins("storage:updated", payload)
  emitToAdmins("inventory:updated", payload)
  emitToUser(booking.client?._id || booking.client, "booking:stored", payload)

  await notifyClient(booking, "Container stored in assigned area", "Your container has been successfully placed in the assigned yard area.", [
    { label: "Assigned Area", value: payload.assignedAreaName },
    { label: "Slot", value: payload.assignedSlotNumber },
  ])

  return res.json({ success: true, message: "Container marked as stored in assigned area.", booking: payload })
}

export const submitBookingPayment = async (req, res) => {
  const booking = await Booking.findOne({ _id: req.params.id, client: req.user._id })
  if (!booking) return res.status(404).json({ success: false, message: "Booking not found." })

  if (!["stored_in_assigned_area", "gate_out_requested", "gate_out_approved"].includes(booking.status)) {
    return res.status(400).json({ success: false, message: "Payment can only be submitted after the container is stored in the assigned area." })
  }

  if (!req.body.paymentAmount || !req.body.paymentReferenceNumber) {
    return res.status(400).json({ success: false, message: "Payment amount and reference number are required." })
  }

  const paymentProofs = await uploadBookingPaymentDocuments({ files: req.files, bookingReference: booking.bookingReference })
  if (paymentProofs.length === 0) {
    return res.status(400).json({ success: false, message: "Please upload at least one payment proof." })
  }

  booking.paymentAmount = toNumber(req.body.paymentAmount, 0)
  booking.paymentReferenceNumber = req.body.paymentReferenceNumber
  booking.paymentDate = req.body.paymentDate || new Date()
  booking.paymentRemarks = req.body.paymentRemarks || ""
  booking.paymentProofs = [...booking.paymentProofs, ...paymentProofs]
  booking.paymentSubmittedAt = new Date()
  booking.paymentRejectionReason = ""
  booking.billingStatus = "payment_under_review"
  addHistory(booking, { billingStatus: "payment_under_review", remarks: "Payment proof submitted by client.", changedBy: req.user._id })

  await booking.save()
  await booking.populate("client", "name email companyName phoneNumber")
  await booking.populate("assignedArea", "name code")
  await booking.populate("assignedBlock", "name code")

  const payload = safeBooking(booking)
  emitToAdmins("booking:payment_submitted", payload)
  emitToUser(req.user._id, "booking:payment_submitted", payload)

  await notifyClient(booking, "Payment submitted", "Your payment proof was submitted and is now under admin review.", [
    { label: "Reference Number", value: booking.paymentReferenceNumber },
    { label: "Amount", value: `PHP ${booking.paymentAmount.toLocaleString()}` },
  ])
  await notifyAdmin(booking, "Payment submitted for review", "A client uploaded payment proof for review.", [
    { label: "Client", value: getClientDisplayName(booking.client) },
    { label: "Reference Number", value: booking.paymentReferenceNumber },
  ])

  return res.json({ success: true, message: "Payment submitted for admin review.", booking: payload })
}

export const approveBookingPayment = async (req, res) => {
  const booking = await Booking.findById(req.params.id)
  if (!booking) return res.status(404).json({ success: false, message: "Booking not found." })

  if (!["payment_submitted", "payment_under_review", "payment_rejected"].includes(booking.billingStatus)) {
    return res.status(400).json({ success: false, message: "Only submitted payments can be approved." })
  }

  booking.billingStatus = "paid_approved"
  booking.paymentReviewedAt = new Date()
  booking.paymentReviewedBy = req.user._id
  booking.paymentRejectionReason = ""
  addHistory(booking, { billingStatus: "paid_approved", remarks: req.body.remarks || "Payment approved by admin.", changedBy: req.user._id })

  await booking.save()
  await booking.populate("client", "name email companyName phoneNumber")
  await booking.populate("assignedArea", "name code")
  await booking.populate("assignedBlock", "name code")

  const payload = safeBooking(booking)
  emitToAdmins("booking:payment_approved", payload)
  emitToUser(booking.client?._id || booking.client, "booking:payment_approved", payload)

  await notifyClient(booking, "Payment approved", "Your payment has been approved. You can now request gate-out from the booking details page.", [
    { label: "Payment Reference", value: booking.paymentReferenceNumber },
  ])

  return res.json({ success: true, message: "Payment approved.", booking: payload })
}

export const rejectBookingPayment = async (req, res) => {
  const booking = await Booking.findById(req.params.id)
  if (!booking) return res.status(404).json({ success: false, message: "Booking not found." })

  const reason = req.body.reason || "Payment proof was rejected by admin."
  booking.billingStatus = "payment_rejected"
  booking.paymentReviewedAt = new Date()
  booking.paymentReviewedBy = req.user._id
  booking.paymentRejectionReason = reason
  addHistory(booking, { billingStatus: "payment_rejected", remarks: `Payment rejected: ${reason}`, changedBy: req.user._id })

  await booking.save()
  await booking.populate("client", "name email companyName phoneNumber")
  await booking.populate("assignedArea", "name code")
  await booking.populate("assignedBlock", "name code")

  const payload = safeBooking(booking)
  emitToAdmins("booking:payment_rejected", payload)
  emitToUser(booking.client?._id || booking.client, "booking:payment_rejected", payload)

  await notifyClient(booking, "Payment rejected", "Your payment proof was rejected. Please upload corrected payment details.", [
    { label: "Reason", value: reason },
  ])

  return res.json({ success: true, message: "Payment rejected.", booking: payload })
}

export const requestBookingGateOut = async (req, res) => {
  const booking = await Booking.findOne({ _id: req.params.id, client: req.user._id })
  if (!booking) return res.status(404).json({ success: false, message: "Booking not found." })

  if (booking.status !== "stored_in_assigned_area") {
    return res.status(400).json({ success: false, message: "Gate-out can only be requested after the container is stored in the assigned area." })
  }

  if (booking.billingStatus !== "paid_approved") {
    return res.status(403).json({ success: false, message: "Gate-out request is allowed only when billing status is Paid / Approved." })
  }

  booking.status = "gate_out_requested"
  booking.gateOutRequestedAt = new Date()
  booking.gateOutRequestRemarks = req.body.remarks || ""
  addHistory(booking, { remarks: "Gate-out requested by client.", changedBy: req.user._id })

  await booking.save()
  await booking.populate("client", "name email companyName phoneNumber")
  await booking.populate("assignedArea", "name code")
  await booking.populate("assignedBlock", "name code")

  const payload = safeBooking(booking)
  emitToAdmins("booking:gate_out_requested", payload)
  emitToUser(req.user._id, "booking:gate_out_requested", payload)

  await notifyClient(booking, "Gate-out requested", "Your gate-out request has been submitted and is waiting for admin approval.", [
    { label: "Container", value: booking.containerNumber },
  ])
  await notifyAdmin(booking, "Gate-out requested", "A client has requested gate-out release for a container.", [
    { label: "Client", value: getClientDisplayName(booking.client) },
    { label: "Container", value: booking.containerNumber },
  ])

  return res.json({ success: true, message: "Gate-out request submitted.", booking: payload })
}

export const approveBookingGateOut = async (req, res) => {
  const booking = await Booking.findById(req.params.id)
  if (!booking) return res.status(404).json({ success: false, message: "Booking not found." })

  if (booking.status !== "gate_out_requested") {
    return res.status(400).json({ success: false, message: "Only requested gate-out bookings can be approved." })
  }

  if (booking.billingStatus !== "paid_approved") {
    return res.status(403).json({ success: false, message: "Payment must be paid / approved before gate-out approval." })
  }

  booking.status = "gate_out_approved"
  booking.gateOutApprovedAt = new Date()
  booking.gateOutApprovedBy = req.user._id
  booking.gateOutRemarks = req.body.remarks || ""
  addHistory(booking, { remarks: "Gate-out approved by admin.", changedBy: req.user._id })

  await booking.save()
  await booking.populate("client", "name email companyName phoneNumber")
  await booking.populate("assignedArea", "name code")
  await booking.populate("assignedBlock", "name code")

  const payload = safeBooking(booking)
  emitToAdmins("booking:gate_out_approved", payload)
  emitToUser(booking.client?._id || booking.client, "booking:gate_out_approved", payload)

  await notifyClient(booking, "Gate-out approved", "Your container is approved for release from the yard.", [
    { label: "Container", value: booking.containerNumber },
    { label: "Assigned Slot", value: booking.assignedSlotNumber },
  ])

  return res.json({ success: true, message: "Gate-out approved.", booking: payload })
}

export const completeBookingGateOut = async (req, res) => {
  const booking = await Booking.findById(req.params.id)
  if (!booking) return res.status(404).json({ success: false, message: "Booking not found." })

  if (booking.status !== "gate_out_approved") {
    return res.status(400).json({ success: false, message: "Only approved gate-out bookings can be completed." })
  }

  const actualContainerNumber = normalizeContainerNumber(req.body.actualContainerNumber || booking.containerNumber)
  if (actualContainerNumber !== booking.containerNumber) {
    return res.status(400).json({ success: false, message: "Final container number must match the booking." })
  }

  const previousBlockId = booking.assignedBlock ? String(booking.assignedBlock) : ""

  booking.status = "completed_gate_out_done"
  booking.releasedAt = new Date()
  booking.releasedBy = req.user._id
  booking.releaseRemarks = req.body.remarks || ""
  addHistory(booking, { remarks: "Container released and booking completed.", changedBy: req.user._id })

  await booking.save()
  if (previousBlockId) await recalculateBlockOccupancy(previousBlockId)
  await booking.populate("client", "name email companyName phoneNumber")
  await booking.populate("assignedArea", "name code")
  await booking.populate("assignedBlock", "name code")

  const payload = safeBooking(booking)
  emitToAdmins("booking:completed", payload)
  emitToAdmins("yard:slot_released", { ...payload, previousBlockId })
  emitToAdmins("storage:updated", payload)
  emitToAdmins("inventory:updated", payload)
  emitToUser(booking.client?._id || booking.client, "booking:completed", payload)

  await notifyClient(booking, "Container released", "Your container has successfully left the yard. The booking is now completed.", [
    { label: "Container", value: booking.containerNumber },
  ])

  return res.json({ success: true, message: "Gate-out completed and booking marked as done.", booking: payload })
}

export const relocateBooking = async (req, res) => {
  const booking = await Booking.findById(req.params.id)
  if (!booking) return res.status(404).json({ success: false, message: "Booking not found." })

  if (!["approved_area_assigned", "gate_in_approved", "stored_in_assigned_area"].includes(booking.status)) {
    return res.status(400).json({
      success: false,
      message: "Only approved, gate-in approved, or stored bookings can be relocated.",
    })
  }

  let plan
  try {
    plan = await validateYardAssignment({
      areaId: req.body.areaId,
      blockId: req.body.blockId,
      bay: req.body.bay,
      row: req.body.row,
      tier: req.body.tier,
      containerSize: booking.containerSize,
      bookingId: booking._id,
    })
  } catch (error) {
    return handleValidationError(error, res)
  }

  const previousBlockId = booking.assignedBlock ? String(booking.assignedBlock) : ""
  const previousSlot = booking.assignedSlotNumber || ""

  booking.assignedArea = plan.area._id
  booking.assignedBlock = plan.block._id
  booking.assignedBay = plan.bay
  booking.assignedRow = plan.row
  booking.assignedTier = plan.tier
  booking.assignedSlotNumber = plan.slotNumber
  booking.assignedAt = new Date()
  booking.assignedBy = req.user._id

  if (booking.status === "stored_in_assigned_area") {
    booking.storageStartDate = booking.storageStartDate || new Date()
  }

  addHistory(booking, {
    remarks: `Yard location updated from ${previousSlot || "unassigned"} to ${plan.slotNumber}.`,
    changedBy: req.user._id,
  })

  await booking.save()
  await recalculateBlockOccupancy(plan.block._id)
  if (previousBlockId && previousBlockId !== String(plan.block._id)) await recalculateBlockOccupancy(previousBlockId)

  await booking.populate("client", "name email companyName phoneNumber")
  await booking.populate("assignedArea", "name code")
  await booking.populate("assignedBlock", "name code teuSlots occupiedSlots bayCount rowCount tierCount containerSize")

  const payload = safeBooking(booking)
  emitToAdmins("booking:relocated", payload)
  emitToAdmins("inventory:updated", payload)
  emitToAdmins("storage:updated", payload)
  emitToAdmins("yard:slot_relocated", { ...payload, previousBlockId, previousSlot })
  emitToUser(booking.client?._id || booking.client, "booking:relocated", payload)

  await notifyClient(booking, "Container yard location updated", "Your container yard location has been updated by the admin.", [
    { label: "Assigned Area", value: payload.assignedAreaName },
    { label: "Slot", value: payload.assignedSlotNumber },
  ])

  return res.json({ success: true, message: "Yard location updated successfully.", booking: payload })
}


export const getPublicBookingByNumber = async (req, res) => {
  const rawNumber = String(req.params.bookingNumber || req.query.bookingNumber || "").trim()
  const lookup = rawNumber.toUpperCase().replace(/[^A-Z0-9-]/g, "")

  if (!lookup) {
    return res.status(400).json({ success: false, message: "Enter a booking number." })
  }

  const booking = await populateBooking(
    Booking.findOne({
      $or: [
        { bookingNumber: lookup },
        { bookingReference: lookup },
      ],
    })
  )

  if (!booking) {
    return res.status(404).json({ success: false, message: "Booking number was not found." })
  }

  return res.json({
    success: true,
    booking: safeBooking(booking),
    trackingUrl: getBookingTrackingUrl(booking.bookingNumber || booking.bookingReference),
  })
}

export const getBookingSummary = async (req, res) => {
  const [total, pending, approved, gateIn, stored, gateOutRequested, completed, unpaid, paymentReview, paid] = await Promise.all([
    Booking.countDocuments(),
    Booking.countDocuments({ status: "pending_admin_approval" }),
    Booking.countDocuments({ status: "approved_area_assigned" }),
    Booking.countDocuments({ status: "gate_in_approved" }),
    Booking.countDocuments({ status: "stored_in_assigned_area" }),
    Booking.countDocuments({ status: "gate_out_requested" }),
    Booking.countDocuments({ status: "completed_gate_out_done" }),
    Booking.countDocuments({ billingStatus: "unpaid" }),
    Booking.countDocuments({ billingStatus: "payment_under_review" }),
    Booking.countDocuments({ billingStatus: "paid_approved" }),
  ])

  return res.json({
    success: true,
    summary: { total, pending, approved, gateIn, stored, gateOutRequested, completed, unpaid, paymentReview, paid },
  })
}
