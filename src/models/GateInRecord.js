import mongoose from "mongoose"

const gateInRecordSchema = new mongoose.Schema(
  {
    preAdvice: { type: mongoose.Schema.Types.ObjectId, ref: "PreAdvice", required: true, unique: true, index: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    gateInNumber: { type: String, required: true, unique: true, index: true },
    containerNumber: { type: String, required: true, uppercase: true, trim: true, index: true },
    actualContainerNumber: { type: String, required: true, uppercase: true, trim: true },
    containerCondition: { type: String, default: "Good", trim: true },
    sealNumber: { type: String, default: "", trim: true },
    truckPlateNumber: { type: String, required: true, trim: true },
    driverName: { type: String, required: true, trim: true },
    driverLicenseNumber: { type: String, default: "", trim: true },
    damageRemarks: { type: String, default: "", trim: true },
    inspectionRemarks: { type: String, default: "", trim: true },

    status: { type: String, enum: ["completed", "cancelled"], default: "completed", index: true },
    completedAt: { type: Date, default: Date.now },
    encodedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
)

export default mongoose.model("GateInRecord", gateInRecordSchema)
