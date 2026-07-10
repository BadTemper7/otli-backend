import PreAdvice from "../models/PreAdvice.js"
import GateInRecord from "../models/GateInRecord.js"
import InventoryContainer from "../models/InventoryContainer.js"
import YardArea from "../models/YardArea.js"
import YardBlock from "../models/YardBlock.js"
import { uploadBufferToCloudinary } from "../config/cloudinary.js"
import { emitToAdmins, emitToUser } from "../socket/socket.js"
import { buildBookingNumber } from "../utils/bookingNumber.js"

const documentLabels = {
  eir: "EIR",
  deliveryOrder: "Delivery Order",
  bookingConfirmation: "Booking Confirmation",
  packingList: "Packing List",
  customsClearance: "Customs Clearance",
  otherDocument: "Other Document",
}

const requiredDocumentFields = ["deliveryOrder", "bookingConfirmation"]

const normalizeContainerNumber = (value = "") => {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, "").trim()
}

const isValidContainerNumber = (value = "") => {
  return /^[A-Z]{4}\d{7}$/.test(normalizeContainerNumber(value))
}

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const getTeuFactor = (size) => {
  if (Number(size) === 40) return 2
  if (Number(size) === 45) return 3
  return 1
}

const toPositive = (value, fallback = 1) => Math.max(toNumber(value, fallback), 1)

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

const buildSequenceNumber = async (prefix, Model, fieldName) => {
  const today = new Date()
  const yyyy = today.getFullYear()
  const mm = String(today.getMonth() + 1).padStart(2, "0")
  const dd = String(today.getDate()).padStart(2, "0")
  const dateCode = `${yyyy}${mm}${dd}`
  const count = await Model.countDocuments({ createdAt: { $gte: new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`) } })
  const seq = String(count + 1).padStart(5, "0")
  const value = `${prefix}-${dateCode}-${seq}`

  const exists = await Model.findOne({ [fieldName]: value })
  if (!exists) return value

  return `${value}-${Date.now().toString().slice(-4)}`
}

const recalculateBlockOccupancy = async (blockId) => {
  if (!blockId) return

  const containers = await InventoryContainer.find({ block: blockId, status: { $ne: "released" } }).select("containerSize")
  const occupiedSlots = containers.reduce((total, container) => total + getTeuFactor(container.containerSize), 0)

  await YardBlock.findByIdAndUpdate(blockId, {
    occupiedSlots: Math.round(occupiedSlots * 100) / 100,
  })
}

const uploadPreAdviceDocuments = async ({ files, containerNumber }) => {
  const uploadedDocs = []
  const safeContainer = normalizeContainerNumber(containerNumber) || `container-${Date.now()}`

  for (const fieldName of Object.keys(documentLabels)) {
    const file = files?.[fieldName]?.[0]
    if (!file) continue

    const result = await uploadBufferToCloudinary({
      file,
      folder: `${process.env.CLOUDINARY_FOLDER || "otli-documents"}/pre-advice`,
      publicIdPrefix: `${safeContainer}-${fieldName}-${Date.now()}`,
    })

    uploadedDocs.push({
      type: fieldName,
      label: documentLabels[fieldName],
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

  return uploadedDocs
}

const safePreAdvice = (preAdvice) => {
  const doc = preAdvice.toObject ? preAdvice.toObject() : preAdvice
  const client = doc.client || {}
  const plannedArea = doc.plannedArea || null
  const plannedBlock = doc.plannedBlock || null

  return {
    id: String(doc._id),
    preAdviceNumber: doc.preAdviceNumber,
    client: client?._id ? String(client._id) : String(doc.client),
    clientName: client.companyName || client.name || "",
    clientEmail: client.email || "",
    containerNumber: doc.containerNumber,
    containerSize: doc.containerSize,
    containerType: doc.containerType,
    containerStatus: doc.containerStatus,
    shippingLine: doc.shippingLine,
    bookingNumber: doc.bookingNumber || "",
    blNumber: doc.blNumber || "",
    vesselVoyage: doc.vesselVoyage || "",
    cargoDescription: doc.cargoDescription || "",
    dangerousGoodsClassification: doc.dangerousGoodsClassification || "",
    weight: Number(doc.weight) || 0,
    arrivalDate: doc.arrivalDate,
    documents: doc.documents || [],
    status: doc.status,
    rejectionReason: doc.rejectionReason || "",
    submittedAt: doc.submittedAt,
    confirmedAt: doc.confirmedAt,
    rejectedAt: doc.rejectedAt,
    gateAppointmentAt: doc.gateAppointmentAt,
    qrCodeValue: doc.qrCodeValue || "",
    plannedArea: plannedArea?._id ? String(plannedArea._id) : doc.plannedArea ? String(doc.plannedArea) : "",
    plannedAreaName: plannedArea?.name || "",
    plannedAreaCode: plannedArea?.code || "",
    plannedBlock: plannedBlock?._id ? String(plannedBlock._id) : doc.plannedBlock ? String(doc.plannedBlock) : "",
    plannedBlockName: plannedBlock?.name || "",
    plannedBlockCode: plannedBlock?.code || "",
    plannedBay: Number(doc.plannedBay) || 1,
    plannedRow: Number(doc.plannedRow) || 1,
    plannedTier: Number(doc.plannedTier) || 1,
    plannedSlotNumber: doc.plannedSlotNumber || "",
    plannedAt: doc.plannedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

const populatePreAdvice = (query) => {
  return query
    .populate("client", "name email companyName")
    .populate("plannedArea", "name code")
    .populate("plannedBlock", "name code")
}

const validateYardPlan = async ({ areaId, blockId, bay, row, tier, containerSize, preAdviceId }) => {
  if (!areaId) {
    const error = new Error("Select yard area before confirming the pre-advice.")
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
    const error = new Error("Only active yard areas can be selected for pre-advice approval.")
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
    const error = new Error("Only active yard areas can be selected for pre-advice approval.")
    error.statusCode = 400
    throw error
  }

  const nextBay = Math.max(toNumber(bay, 1), 1)
  const nextRow = Math.max(toNumber(row, 1), 1)
  const nextTier = Math.max(toNumber(tier, 1), 1)

  if (nextBay > block.bayCount || nextRow > block.rowCount || nextTier > block.tierCount) {
    const error = new Error(`Location is outside yard area limits. Max bay ${block.bayCount}, row ${block.rowCount}, tier ${block.tierCount}.`)
    error.statusCode = 400
    throw error
  }

  const occupiedSlot = await InventoryContainer.findOne({
    block: block._id,
    bay: nextBay,
    row: nextRow,
    tier: nextTier,
    status: { $ne: "released" },
  })

  if (occupiedSlot) {
    const error = new Error("That bay, row, and tier is already occupied in inventory.")
    error.statusCode = 409
    throw error
  }

  const reservedSlot = await PreAdvice.findOne({
    _id: { $ne: preAdviceId },
    plannedBlock: block._id,
    plannedBay: nextBay,
    plannedRow: nextRow,
    plannedTier: nextTier,
    status: "confirmed",
  })

  if (reservedSlot) {
    const error = new Error("That bay, row, and tier is already reserved by another confirmed pre-advice.")
    error.statusCode = 409
    throw error
  }

  const usedTeu = Number(block.occupiedSlots) || 0
  const containerTeu = getTeuFactor(containerSize)

  if (usedTeu + containerTeu > Number(block.teuSlots)) {
    const error = new Error("Selected yard area does not have enough available TEU capacity.")
    error.statusCode = 400
    throw error
  }

  const slotNumber = `${block.code}-B${nextBay}-R${nextRow}-T${nextTier}`

  return {
    area,
    block,
    bay: nextBay,
    row: nextRow,
    tier: nextTier,
    slotNumber,
  }
}

const handleValidationError = (error, res) => {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ success: false, message: error.message })
  }

  throw error
}

export const createClientPreAdvice = async (req, res) => {
  const {
    containerNumber,
    containerSize,
    containerType,
    containerStatus,
    shippingLine,
    blNumber,
    vesselVoyage,
    cargoDescription,
    dangerousGoodsClassification,
    weight,
    arrivalDate,
  } = req.body

  const requiredFields = [containerNumber, containerSize, containerType, containerStatus, shippingLine, arrivalDate]

  if (requiredFields.some((value) => !String(value || "").trim())) {
    return res.status(400).json({ success: false, message: "Please complete all required pre-advice fields." })
  }

  const normalizedContainer = normalizeContainerNumber(containerNumber)

  if (!isValidContainerNumber(normalizedContainer)) {
    return res.status(400).json({ success: false, message: "Container number must follow the format ABCD1234567." })
  }

  const missingDocuments = requiredDocumentFields.filter((fieldName) => !req.files?.[fieldName]?.[0])
  if (missingDocuments.length) {
    return res.status(400).json({
      success: false,
      message: `Missing required documents: ${missingDocuments.map((field) => documentLabels[field]).join(", ")}.`,
    })
  }

  const activeDuplicate = await PreAdvice.findOne({
    containerNumber: normalizedContainer,
    status: { $nin: ["rejected", "cancelled"] },
  })

  if (activeDuplicate) {
    return res.status(409).json({ success: false, message: "This container already has an active pre-advice." })
  }

  const inInventory = await InventoryContainer.findOne({
    containerNumber: normalizedContainer,
    status: { $ne: "released" },
  })

  if (inInventory) {
    return res.status(409).json({ success: false, message: "This container is already in active inventory." })
  }

  const documents = await uploadPreAdviceDocuments({ files: req.files, containerNumber: normalizedContainer })
  const preAdviceNumber = await buildSequenceNumber("PA", PreAdvice, "preAdviceNumber")
  const qrCodeValue = `OTLI:${preAdviceNumber}:${normalizedContainer}`

  const preAdvice = await PreAdvice.create({
    client: req.user._id,
    preAdviceNumber,
    containerNumber: normalizedContainer,
    containerSize: Number(containerSize),
    containerType,
    containerStatus,
    shippingLine,
    blNumber: blNumber || "",
    vesselVoyage: vesselVoyage || "",
    cargoDescription: cargoDescription || "",
    dangerousGoodsClassification: dangerousGoodsClassification || "",
    weight: Number(weight) || 0,
    arrivalDate,
    documents,
    status: "pending_admin_confirmation",
    submittedAt: new Date(),
    qrCodeValue,
  })

  await preAdvice.populate("client", "name email companyName")
  const payload = safePreAdvice(preAdvice)

  emitToAdmins("preAdvice:submitted", payload)

  return res.status(201).json({ success: true, message: "Pre-advice submitted for admin confirmation.", preAdvice: payload })
}

export const listClientPreAdvices = async (req, res) => {
  const preAdvices = await populatePreAdvice(PreAdvice.find({ client: req.user._id })).sort({ createdAt: -1 })

  return res.json({ success: true, preAdvices: preAdvices.map(safePreAdvice) })
}

export const listAdminPreAdvices = async (req, res) => {
  const status = req.query.status
  const query = status && status !== "all" ? { status } : {}
  const preAdvices = await populatePreAdvice(PreAdvice.find(query)).sort({ createdAt: -1 }).limit(200)

  return res.json({ success: true, preAdvices: preAdvices.map(safePreAdvice) })
}

export const confirmPreAdvice = async (req, res) => {
  const preAdvice = await populatePreAdvice(PreAdvice.findById(req.params.id))

  if (!preAdvice) {
    return res.status(404).json({ success: false, message: "Pre-advice not found." })
  }

  if (!["submitted", "pending_admin_confirmation", "rejected", "confirmed"].includes(preAdvice.status)) {
    return res.status(400).json({ success: false, message: `Pre-advice cannot be confirmed from ${preAdvice.status} status.` })
  }

  let plan
  try {
    plan = await validateYardPlan({
      areaId: req.body.areaId,
      blockId: req.body.blockId,
      bay: req.body.bay,
      row: req.body.row,
      tier: req.body.tier,
      containerSize: preAdvice.containerSize,
      preAdviceId: preAdvice._id,
    })
  } catch (error) {
    return handleValidationError(error, res)
  }

  if (!preAdvice.bookingNumber) {
    preAdvice.bookingNumber = await buildBookingNumber()
  }

  preAdvice.status = "confirmed"
  preAdvice.rejectionReason = ""
  preAdvice.confirmedAt = new Date()
  preAdvice.rejectedAt = null
  preAdvice.reviewedBy = req.user._id
  preAdvice.plannedArea = plan.area._id
  preAdvice.plannedBlock = plan.block._id
  preAdvice.plannedBay = plan.bay
  preAdvice.plannedRow = plan.row
  preAdvice.plannedTier = plan.tier
  preAdvice.plannedSlotNumber = plan.slotNumber
  preAdvice.plannedAt = new Date()
  preAdvice.plannedBy = req.user._id

  if (req.body.gateAppointmentAt) {
    preAdvice.gateAppointmentAt = req.body.gateAppointmentAt
  }

  await preAdvice.save()
  await preAdvice.populate("client", "name email companyName")
  await preAdvice.populate("plannedArea", "name code")
  await preAdvice.populate("plannedBlock", "name code")

  const payload = safePreAdvice(preAdvice)
  emitToAdmins("preAdvice:confirmed", payload)
  emitToUser(preAdvice.client?._id || preAdvice.client, "preAdvice:confirmed", payload)

  return res.json({
    success: true,
    message: "Pre-advice confirmed with yard location. Container can now proceed to Gate-In.",
    preAdvice: payload,
  })
}

export const rejectPreAdvice = async (req, res) => {
  const { rejectionReason } = req.body
  const preAdvice = await populatePreAdvice(PreAdvice.findById(req.params.id))

  if (!preAdvice) {
    return res.status(404).json({ success: false, message: "Pre-advice not found." })
  }

  if (!String(rejectionReason || "").trim()) {
    return res.status(400).json({ success: false, message: "Rejection reason is required." })
  }

  if (["used_for_gate_in"].includes(preAdvice.status)) {
    return res.status(400).json({ success: false, message: "Pre-advice already used for Gate-In." })
  }

  preAdvice.status = "rejected"
  preAdvice.rejectionReason = rejectionReason
  preAdvice.rejectedAt = new Date()
  preAdvice.confirmedAt = null
  preAdvice.reviewedBy = req.user._id
  preAdvice.plannedArea = null
  preAdvice.plannedBlock = null
  preAdvice.plannedBay = 1
  preAdvice.plannedRow = 1
  preAdvice.plannedTier = 1
  preAdvice.plannedSlotNumber = ""
  preAdvice.plannedAt = null
  preAdvice.plannedBy = null

  await preAdvice.save()

  const payload = safePreAdvice(preAdvice)
  emitToAdmins("preAdvice:rejected", payload)
  emitToUser(preAdvice.client?._id || preAdvice.client, "preAdvice:rejected", payload)

  return res.json({ success: true, message: "Pre-advice rejected.", preAdvice: payload })
}

export const listGateInReadyPreAdvices = async (req, res) => {
  const preAdvices = await populatePreAdvice(PreAdvice.find({ status: "confirmed" })).sort({ confirmedAt: -1, createdAt: -1 })

  return res.json({ success: true, preAdvices: preAdvices.map(safePreAdvice) })
}

const safeGateIn = (record) => {
  const doc = record.toObject ? record.toObject() : record

  return {
    id: String(doc._id),
    preAdvice: doc.preAdvice?._id ? String(doc.preAdvice._id) : String(doc.preAdvice),
    gateInNumber: doc.gateInNumber,
    client: doc.client?._id ? String(doc.client._id) : String(doc.client),
    clientName: doc.client?.companyName || doc.client?.name || "",
    containerNumber: doc.containerNumber,
    actualContainerNumber: doc.actualContainerNumber,
    containerCondition: doc.containerCondition,
    sealNumber: doc.sealNumber || "",
    truckPlateNumber: doc.truckPlateNumber,
    driverName: doc.driverName,
    driverLicenseNumber: doc.driverLicenseNumber || "",
    damageRemarks: doc.damageRemarks || "",
    inspectionRemarks: doc.inspectionRemarks || "",
    status: doc.status,
    completedAt: doc.completedAt,
  }
}

export const completeGateIn = async (req, res) => {
  const {
    actualContainerNumber,
    containerCondition,
    sealNumber,
    truckPlateNumber,
    driverName,
    driverLicenseNumber,
    damageRemarks,
    inspectionRemarks,
  } = req.body

  const preAdvice = await populatePreAdvice(PreAdvice.findById(req.params.preAdviceId))

  if (!preAdvice) {
    return res.status(404).json({ success: false, message: "Pre-advice not found." })
  }

  if (preAdvice.status !== "confirmed") {
    return res.status(400).json({ success: false, message: "Only confirmed pre-advice can be used for Gate-In." })
  }

  if (!preAdvice.plannedArea || !preAdvice.plannedBlock) {
    return res.status(400).json({ success: false, message: "This pre-advice has no approved yard location. Confirm it with area and block first." })
  }

  const normalizedActual = normalizeContainerNumber(actualContainerNumber || preAdvice.containerNumber)

  if (normalizedActual !== preAdvice.containerNumber) {
    return res.status(400).json({ success: false, message: "Actual container number must match the confirmed pre-advice." })
  }

  if (!truckPlateNumber || !driverName) {
    return res.status(400).json({ success: false, message: "Truck plate number and driver name are required." })
  }

  const existingGateIn = await GateInRecord.findOne({ preAdvice: preAdvice._id })
  if (existingGateIn) {
    return res.status(409).json({ success: false, message: "This pre-advice already has a Gate-In record." })
  }

  const gateInNumber = await buildSequenceNumber("GI", GateInRecord, "gateInNumber")

  const gateIn = await GateInRecord.create({
    preAdvice: preAdvice._id,
    client: preAdvice.client?._id || preAdvice.client,
    gateInNumber,
    containerNumber: preAdvice.containerNumber,
    actualContainerNumber: normalizedActual,
    containerCondition: containerCondition || "Good",
    sealNumber: sealNumber || "",
    truckPlateNumber,
    driverName,
    driverLicenseNumber: driverLicenseNumber || "",
    damageRemarks: damageRemarks || "",
    inspectionRemarks: inspectionRemarks || "",
    status: "completed",
    completedAt: new Date(),
    encodedBy: req.user._id,
  })

  const inventoryContainer = await InventoryContainer.create({
    preAdvice: preAdvice._id,
    gateIn: gateIn._id,
    client: preAdvice.client?._id || preAdvice.client,
    containerNumber: preAdvice.containerNumber,
    containerSize: preAdvice.containerSize,
    containerType: preAdvice.containerType,
    containerStatus: preAdvice.containerStatus,
    shippingLine: preAdvice.shippingLine,
    bookingNumber: preAdvice.bookingNumber,
    blNumber: preAdvice.blNumber,
    customerName: preAdvice.client?.companyName || preAdvice.client?.name || "",
    status: "in_yard",
    area: preAdvice.plannedArea?._id || preAdvice.plannedArea,
    block: preAdvice.plannedBlock?._id || preAdvice.plannedBlock,
    bay: preAdvice.plannedBay || 1,
    row: preAdvice.plannedRow || 1,
    tier: preAdvice.plannedTier || 1,
    slotNumber: preAdvice.plannedSlotNumber || "",
    storageStartDate: new Date(),
    containerCondition: containerCondition || "Good",
    truckPlateNumber,
    driverName,
    damageRemarks: damageRemarks || "",
    assignedAt: new Date(),
    assignedBy: preAdvice.plannedBy || req.user._id,
  })

  preAdvice.status = "used_for_gate_in"
  await preAdvice.save()

  await recalculateBlockOccupancy(preAdvice.plannedBlock?._id || preAdvice.plannedBlock)
  await gateIn.populate("client", "name email companyName")
  await inventoryContainer.populate("area", "name code")
  await inventoryContainer.populate("block", "name code")

  const gateInPayload = safeGateIn(gateIn)
  const inventoryPayload = {
    id: String(inventoryContainer._id),
    containerNumber: inventoryContainer.containerNumber,
    status: inventoryContainer.status,
    area: inventoryContainer.area?._id ? String(inventoryContainer.area._id) : String(inventoryContainer.area),
    areaName: inventoryContainer.area?.name || "",
    block: inventoryContainer.block?._id ? String(inventoryContainer.block._id) : String(inventoryContainer.block),
    blockName: inventoryContainer.block?.name || "",
    blockCode: inventoryContainer.block?.code || "",
    bay: inventoryContainer.bay,
    row: inventoryContainer.row,
    tier: inventoryContainer.tier,
    slotNumber: inventoryContainer.slotNumber,
  }

  emitToAdmins("gateIn:completed", gateInPayload)
  emitToAdmins("inventory:container_created", inventoryPayload)
  emitToUser(preAdvice.client?._id || preAdvice.client, "gateIn:completed", gateInPayload)

  return res.status(201).json({
    success: true,
    message: "Gate-In completed. Container was automatically placed in the approved yard location.",
    gateIn: gateInPayload,
    inventoryContainer: inventoryPayload,
  })
}
