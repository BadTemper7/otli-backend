import mongoose from "mongoose"

const documentSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    label: { type: String, required: true },
    fileName: { type: String, required: true },
    url: { type: String, required: true },
    secureUrl: { type: String, default: "" },
    publicId: { type: String, required: true },
    resourceType: { type: String, default: "auto" },
    mimeType: { type: String, default: "" },
    sizeBytes: { type: Number, default: 0 },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
)


const billingLineItemSchema = new mongoose.Schema(
  {
    rate: { type: mongoose.Schema.Types.ObjectId, ref: "BillingRate", default: null },
    chargeCode: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },
    unit: { type: String, default: "per_container", trim: true },
    quantity: { type: Number, default: 1 },
    rateAmount: { type: Number, default: 0 },
    freeDays: { type: Number, default: 0 },
    minimumAmount: { type: Number, default: 0 },
    category: { type: String, default: "", trim: true },
    billingScope: { type: String, default: "", trim: true },
    amount: { type: Number, default: 0 },
  },
  { _id: false }
)

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    billingStatus: { type: String, default: "" },
    remarks: { type: String, default: "" },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
)

const bookingSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    bookingReference: { type: String, required: true, unique: true, index: true },

    containerNumber: { type: String, required: true, uppercase: true, trim: true, index: true },
    containerSize: { type: Number, enum: [20, 40, 45], required: true },
    containerType: {
      type: String,
      enum: ["dry", "reefer", "tank", "open_top", "flat_rack"],
      required: true,
    },
    containerLoadStatus: { type: String, enum: ["empty", "laden"], default: "empty" },
    serviceType: {
      type: String,
      enum: ["container_yard", "stripping_stuffing_mano"],
      default: "container_yard",
      index: true,
    },
    shippingLine: { type: String, required: true, trim: true },
    bookingNumber: { type: String, default: "", trim: true },
    qrCodeValue: { type: String, default: "", trim: true },
    blNumber: { type: String, default: "", trim: true },
    vesselVoyage: { type: String, default: "", trim: true },
    cargoDescription: { type: String, default: "", trim: true },
    weight: { type: Number, default: 0 },
    expectedArrivalDate: { type: Date, required: true },
    inDate: { type: Date, default: null, index: true },
    outDate: { type: Date, default: null, index: true },
    clientRemarks: { type: String, default: "", trim: true },

    status: {
      type: String,
      enum: [
        "pending_admin_approval",
        "approved_area_assigned",
        "rejected",
        "gate_in_approved",
        "stored_in_assigned_area",
        "gate_out_requested",
        "gate_out_approved",
        "completed_gate_out_done",
        "cancelled",
      ],
      default: "pending_admin_approval",
      index: true,
    },

    billingStatus: {
      type: String,
      enum: ["unpaid", "payment_submitted", "payment_under_review", "payment_rejected", "paid_approved"],
      default: "unpaid",
      index: true,
    },

    rejectionReason: { type: String, default: "" },
    submittedAt: { type: Date, default: Date.now },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    assignedArea: { type: mongoose.Schema.Types.ObjectId, ref: "YardArea", default: null, index: true },
    assignedBlock: { type: mongoose.Schema.Types.ObjectId, ref: "YardBlock", default: null, index: true },
    assignedBay: { type: Number, default: 1 },
    assignedRow: { type: Number, default: 1 },
    assignedTier: { type: Number, default: 1 },
    assignedSlotNumber: { type: String, default: "" },
    assignedAt: { type: Date, default: null },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    gateInApprovedAt: { type: Date, default: null },
    gateInApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actualContainerNumber: { type: String, default: "", uppercase: true, trim: true },
    physicalCondition: { type: String, default: "Good", trim: true },
    sealNumber: { type: String, default: "", trim: true },
    truckPlateNumber: { type: String, default: "", trim: true },
    driverName: { type: String, default: "", trim: true },
    driverLicenseNumber: { type: String, default: "", trim: true },
    inspectionRemarks: { type: String, default: "", trim: true },

    storedAt: { type: Date, default: null },
    storedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    storageStartDate: { type: Date, default: null },

    billingLineItems: { type: [billingLineItemSchema], default: [] },
    billingSubtotal: { type: Number, default: 0 },
    billingTotal: { type: Number, default: 0 },
    billingDays: { type: Number, default: 0 },
    billingComputedAt: { type: Date, default: null },

    paymentAmount: { type: Number, default: 0 },
    paymentReferenceNumber: { type: String, default: "", trim: true },
    paymentDate: { type: Date, default: null },
    paymentRemarks: { type: String, default: "", trim: true },
    paymentProofs: { type: [documentSchema], default: [] },
    paymentSubmittedAt: { type: Date, default: null },
    paymentReviewedAt: { type: Date, default: null },
    paymentReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    paymentRejectionReason: { type: String, default: "" },

    gateOutRequestedAt: { type: Date, default: null },
    gateOutRequestRemarks: { type: String, default: "", trim: true },
    gateOutApprovedAt: { type: Date, default: null },
    gateOutApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    gateOutRemarks: { type: String, default: "", trim: true },
    releasedAt: { type: Date, default: null },
    releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    releaseRemarks: { type: String, default: "", trim: true },

    statusHistory: { type: [statusHistorySchema], default: [] },
  },
  { timestamps: true }
)

bookingSchema.index({ assignedBlock: 1, assignedBay: 1, assignedRow: 1, assignedTier: 1, status: 1 })
bookingSchema.index({ containerNumber: 1, status: 1 })

bookingSchema.pre("validate", function () {
  if (this.containerNumber) {
    this.containerNumber = String(this.containerNumber).toUpperCase().replace(/[^A-Z0-9]/g, "").trim()
  }

  if (this.actualContainerNumber) {
    this.actualContainerNumber = String(this.actualContainerNumber).toUpperCase().replace(/[^A-Z0-9]/g, "").trim()
  }

  this.assignedBay = Math.max(Number(this.assignedBay) || 1, 1)
  this.assignedRow = Math.max(Number(this.assignedRow) || 1, 1)
  this.assignedTier = Math.max(Number(this.assignedTier) || 1, 1)
  this.billingSubtotal = Math.max(Number(this.billingSubtotal) || 0, 0)
  this.billingTotal = Math.max(Number(this.billingTotal) || 0, 0)
  this.billingDays = Math.max(Number(this.billingDays) || 0, 0)
  this.paymentAmount = Math.max(Number(this.paymentAmount) || 0, 0)
  this.weight = Math.max(Number(this.weight) || 0, 0)
})

export default mongoose.model("Booking", bookingSchema)
