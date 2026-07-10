import BillingRate from "../models/BillingRate.js"
import { emitToAdmins } from "../socket/socket.js"

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const OTLI_REFERENCE_RATES = [
  {
    category: "container_yard_operation",
    billingScope: "base",
    description: "Lift On Charge",
    chargeCode: "LIFT_ON_20",
    unit: "per_teu",
    containerSize: "all",
    rateAmount: 500,
    sortOrder: 10,
    notes: "Reference: PHP 500 per 20 ft equivalent. A 40ft container is charged x2.",
  },
  {
    category: "container_yard_operation",
    billingScope: "base",
    description: "Lift Off Charge",
    chargeCode: "LIFT_OFF_20",
    unit: "per_teu",
    containerSize: "all",
    rateAmount: 500,
    sortOrder: 20,
    notes: "Reference: PHP 500 per 20 ft equivalent. A 40ft container is charged x2.",
  },
  {
    category: "container_yard_operation",
    billingScope: "display_only",
    description: "Total Handling per Container Cycle",
    chargeCode: "TOTAL_HANDLING_CYCLE_20",
    unit: "per_container",
    containerSize: "20",
    rateAmount: 1000,
    sortOrder: 30,
    notes: "Display reference only. This is the total of Lift On and Lift Off, so it is not added again to billing.",
  },
  {
    category: "container_yard_operation",
    billingScope: "storage",
    description: "Storage",
    chargeCode: "STORAGE_20_DAY",
    unit: "storage_day",
    containerSize: "20",
    rateAmount: 100,
    sortOrder: 40,
    notes: "Reference: per 20 ft container per day.",
  },
  {
    category: "container_yard_operation",
    billingScope: "storage",
    description: "Storage",
    chargeCode: "STORAGE_40_DAY",
    unit: "storage_day",
    containerSize: "40",
    rateAmount: 200,
    sortOrder: 50,
    notes: "Reference: per 40 ft container per day.",
  },
  {
    category: "container_yard_operation",
    billingScope: "display_only",
    description: "Congestion Surcharge",
    chargeCode: "CONGESTION_20",
    unit: "per_container",
    containerSize: "20",
    rateAmount: 100,
    sortOrder: 60,
    notes: "Display reference only by default. Change billing scope to Base Auto Charge if congestion should be billed automatically.",
  },
  {
    category: "container_yard_operation",
    billingScope: "display_only",
    description: "Congestion Surcharge",
    chargeCode: "CONGESTION_40",
    unit: "per_container",
    containerSize: "40",
    rateAmount: 200,
    sortOrder: 70,
    notes: "Display reference only by default. Change billing scope to Base Auto Charge if congestion should be billed automatically.",
  },
  {
    category: "stripping_stuffing",
    billingScope: "optional_stripping_stuffing",
    description: "Stripping / Stuffing (with Mano)",
    chargeCode: "STRIPPING_STUFFING_MANO_20",
    unit: "per_container",
    containerSize: "20",
    rateAmount: 4000,
    sortOrder: 80,
    notes: "Added only when the booking service is Stripping / Stuffing with Mano.",
  },
  {
    category: "stripping_stuffing",
    billingScope: "optional_stripping_stuffing",
    description: "Stripping / Stuffing (with Mano)",
    chargeCode: "STRIPPING_STUFFING_MANO_40",
    unit: "per_container",
    containerSize: "40",
    rateAmount: 8000,
    sortOrder: 90,
    notes: "Added only when the booking service is Stripping / Stuffing with Mano.",
  },
]

const safeRate = (rate) => {
  const doc = rate.toObject ? rate.toObject() : rate
  return {
    id: String(doc._id),
    description: doc.description,
    chargeCode: doc.chargeCode,
    category: doc.category || "container_yard_operation",
    billingScope: doc.billingScope || "base",
    unit: doc.unit,
    containerSize: doc.containerSize,
    containerType: doc.containerType,
    loadStatus: doc.loadStatus,
    rateAmount: Number(doc.rateAmount) || 0,
    freeDays: Number(doc.freeDays) || 0,
    minimumAmount: Number(doc.minimumAmount) || 0,
    effectiveDate: doc.effectiveDate,
    status: doc.status,
    notes: doc.notes || "",
    sortOrder: Number(doc.sortOrder) || 100,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

const normalizeRatePayload = (body = {}) => ({
  description: String(body.description || "").trim(),
  chargeCode: String(body.chargeCode || body.description || "").trim(),
  category: body.category || "container_yard_operation",
  billingScope: body.billingScope || "base",
  unit: body.unit || (body.billingScope === "storage" ? "storage_day" : "per_container"),
  containerSize: String(body.containerSize || "all"),
  containerType: body.containerType || "all",
  loadStatus: body.loadStatus || "all",
  rateAmount: toNumber(body.rateAmount, 0),
  freeDays: toNumber(body.freeDays, 0),
  minimumAmount: toNumber(body.minimumAmount, 0),
  effectiveDate: body.effectiveDate || new Date(),
  status: body.status || "active",
  notes: body.notes || "",
  sortOrder: toNumber(body.sortOrder, 100),
})

export const listBillingRates = async (req, res) => {
  const { status, search, category } = req.query
  const query = {}

  if (status && status !== "all") query.status = status
  if (category && category !== "all") query.category = category
  if (search) {
    const term = String(search).trim()
    query.$or = [
      { description: { $regex: term, $options: "i" } },
      { chargeCode: { $regex: term, $options: "i" } },
      { notes: { $regex: term, $options: "i" } },
    ]
  }

  const rates = await BillingRate.find(query).sort({ category: 1, sortOrder: 1, status: 1, effectiveDate: -1, createdAt: -1 }).limit(300)
  return res.json({ success: true, rates: rates.map(safeRate), referenceRates: OTLI_REFERENCE_RATES })
}

export const createBillingRate = async (req, res) => {
  const payload = normalizeRatePayload(req.body)
  if (!payload.description) {
    return res.status(400).json({ success: false, message: "Rate description is required." })
  }
  if (payload.rateAmount <= 0) {
    return res.status(400).json({ success: false, message: "Rate amount must be greater than zero." })
  }

  const rate = await BillingRate.create(payload)
  const safe = safeRate(rate)
  emitToAdmins("billing_rate:created", safe)
  return res.status(201).json({ success: true, message: "Billing rate created successfully.", rate: safe })
}

export const updateBillingRate = async (req, res) => {
  const rate = await BillingRate.findById(req.params.id)
  if (!rate) return res.status(404).json({ success: false, message: "Billing rate not found." })

  const payload = normalizeRatePayload({ ...rate.toObject(), ...req.body })
  if (!payload.description) {
    return res.status(400).json({ success: false, message: "Rate description is required." })
  }
  if (payload.rateAmount <= 0) {
    return res.status(400).json({ success: false, message: "Rate amount must be greater than zero." })
  }

  Object.assign(rate, payload)
  await rate.save()
  const safe = safeRate(rate)
  emitToAdmins("billing_rate:updated", safe)
  return res.json({ success: true, message: "Billing rate updated successfully.", rate: safe })
}

export const seedReferenceBillingRates = async (req, res) => {
  const effectiveDate = req.body?.effectiveDate || new Date().toISOString().slice(0, 10)
  const mode = req.body?.mode || "upsert"
  const createdOrUpdated = []

  for (const template of OTLI_REFERENCE_RATES) {
    const payload = normalizeRatePayload({
      ...template,
      effectiveDate,
      status: "active",
      containerType: "all",
      loadStatus: "all",
      freeDays: 0,
      minimumAmount: 0,
    })

    let rate = await BillingRate.findOne({ chargeCode: payload.chargeCode })
    if (rate && mode === "skip_existing") {
      createdOrUpdated.push(rate)
      continue
    }

    if (rate) {
      Object.assign(rate, payload)
      await rate.save()
    } else {
      rate = await BillingRate.create(payload)
    }
    createdOrUpdated.push(rate)
  }

  const rates = await BillingRate.find({ chargeCode: { $in: OTLI_REFERENCE_RATES.map((rate) => rate.chargeCode) } }).sort({ category: 1, sortOrder: 1 })
  emitToAdmins("billing_rate:reference_applied", { count: rates.length, effectiveDate })
  return res.json({
    success: true,
    message: "OTLI reference rates have been applied to Rate Setup.",
    rates: rates.map(safeRate),
  })
}

export const deleteBillingRate = async (req, res) => {
  const rate = await BillingRate.findById(req.params.id)
  if (!rate) return res.status(404).json({ success: false, message: "Billing rate not found." })

  const safe = safeRate(rate)
  await rate.deleteOne()
  emitToAdmins("billing_rate:deleted", safe)
  return res.json({ success: true, message: "Billing rate deleted successfully." })
}
