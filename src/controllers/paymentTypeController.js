import PaymentType from "../models/PaymentType.js"
import { deleteFromCloudinary, uploadBufferToCloudinary } from "../config/cloudinary.js"
import { emitToAdmins } from "../socket/socket.js"

const toNumber = (value, fallback = 100) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const safePaymentType = (paymentType) => {
  const doc = paymentType?.toObject ? paymentType.toObject() : paymentType
  if (!doc) return null
  return {
    id: String(doc._id),
    type: doc.type,
    name: doc.name,
    bankName: doc.bankName || "",
    accountNumber: doc.accountNumber,
    accountName: doc.accountName,
    qrUrl: doc.qrSecureUrl || doc.qrUrl || "",
    instructions: doc.instructions || "",
    status: doc.status,
    sortOrder: Number(doc.sortOrder) || 100,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

const normalizePayload = (body = {}) => ({
  type: body.type === "ewallet" ? "ewallet" : "bank",
  name: String(body.name || "").trim(),
  bankName: String(body.bankName || "").trim(),
  accountNumber: String(body.accountNumber || "").trim(),
  accountName: String(body.accountName || "").trim(),
  qrUrl: String(body.qrUrl || "").trim(),
  instructions: String(body.instructions || "").trim(),
  status: body.status === "inactive" ? "inactive" : "active",
  sortOrder: toNumber(body.sortOrder, 100),
})

const validatePayload = (payload) => {
  if (!payload.name) return "Payment name is required."
  if (!payload.accountNumber) return "Account number is required."
  if (!payload.accountName) return "Account owner name is required."
  if (payload.type === "bank" && !payload.bankName) return "Bank name is required for bank payment types."
  return ""
}

const uploadQr = async (file, paymentName) => {
  if (!file) return null
  const result = await uploadBufferToCloudinary({
    file,
    folder: `${process.env.CLOUDINARY_FOLDER || "otli-documents"}/payment-types`,
    publicIdPrefix: `payment-${String(paymentName || "qr").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`,
  })
  return {
    qrUrl: result.url || "",
    qrSecureUrl: result.secure_url || result.url || "",
    qrPublicId: result.public_id || "",
  }
}

export const listPaymentTypes = async (req, res) => {
  const { status, type, search } = req.query
  const query = {}
  if (status && status !== "all") query.status = status
  if (type && type !== "all") query.type = type
  if (search) {
    const term = String(search).trim()
    query.$or = [
      { name: { $regex: term, $options: "i" } },
      { bankName: { $regex: term, $options: "i" } },
      { accountName: { $regex: term, $options: "i" } },
      { accountNumber: { $regex: term, $options: "i" } },
    ]
  }

  const paymentTypes = await PaymentType.find(query).sort({ status: 1, sortOrder: 1, type: 1, name: 1 })
  return res.json({ success: true, paymentTypes: paymentTypes.map(safePaymentType) })
}

export const listActivePaymentTypes = async (req, res) => {
  const paymentTypes = await PaymentType.find({ status: "active" }).sort({ sortOrder: 1, type: 1, name: 1 })
  return res.json({ success: true, paymentTypes: paymentTypes.map(safePaymentType) })
}

export const createPaymentType = async (req, res) => {
  const payload = normalizePayload(req.body)
  const validationError = validatePayload(payload)
  if (validationError) return res.status(400).json({ success: false, message: validationError })

  const qr = await uploadQr(req.file, payload.name)
  const paymentType = await PaymentType.create({ ...payload, ...(qr || {}) })
  const safe = safePaymentType(paymentType)
  emitToAdmins("payment_type:created", safe)
  return res.status(201).json({ success: true, message: "Payment type added successfully.", paymentType: safe })
}

export const updatePaymentType = async (req, res) => {
  const paymentType = await PaymentType.findById(req.params.id)
  if (!paymentType) return res.status(404).json({ success: false, message: "Payment type not found." })

  const payload = normalizePayload({ ...paymentType.toObject(), ...req.body })
  const validationError = validatePayload(payload)
  if (validationError) return res.status(400).json({ success: false, message: validationError })

  const previousPublicId = paymentType.qrPublicId
  const qr = await uploadQr(req.file, payload.name)
  Object.assign(paymentType, payload, qr || {})
  await paymentType.save()

  if (qr && previousPublicId && previousPublicId !== paymentType.qrPublicId) {
    await deleteFromCloudinary(previousPublicId).catch(() => null)
  }

  const safe = safePaymentType(paymentType)
  emitToAdmins("payment_type:updated", safe)
  return res.json({ success: true, message: "Payment type updated successfully.", paymentType: safe })
}

export const deletePaymentType = async (req, res) => {
  const paymentType = await PaymentType.findById(req.params.id)
  if (!paymentType) return res.status(404).json({ success: false, message: "Payment type not found." })

  const safe = safePaymentType(paymentType)
  if (paymentType.qrPublicId) await deleteFromCloudinary(paymentType.qrPublicId).catch(() => null)
  await paymentType.deleteOne()
  emitToAdmins("payment_type:deleted", safe)
  return res.json({ success: true, message: "Payment type deleted successfully." })
}
