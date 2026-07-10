import mongoose from "mongoose"

const yardAreaSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    lineCount: {
      type: Number,
      default: 1,
      min: 1,
    },
    rowCount: {
      type: Number,
      default: 1,
      min: 1,
    },
    tierCount: {
      type: Number,
      default: 1,
      min: 1,
    },
    containerSize: {
      type: Number,
      enum: [20, 40, 45],
      default: 20,
    },
    capacityTeu: {
      type: Number,
      default: 1,
      min: 1,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "maintenance"],
      default: "active",
    },
    color: {
      type: String,
      default: "#0f766e",
      trim: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
)

const getContainerTeuFactor = (size) => {
  if (Number(size) === 40) return 2
  if (Number(size) === 45) return 3
  return 1
}

yardAreaSchema.pre("validate", function () {
  if (this.code) this.code = this.code.toUpperCase().trim()

  this.lineCount = Math.max(Number(this.lineCount) || 1, 1)
  this.rowCount = Math.max(Number(this.rowCount) || 1, 1)
  this.tierCount = Math.max(Number(this.tierCount) || 1, 1)
  this.containerSize = [20, 40, 45].includes(Number(this.containerSize)) ? Number(this.containerSize) : 20

  if (!this.capacityTeu || Number(this.capacityTeu) < 1) {
    const autoCapacity = this.lineCount * this.rowCount * this.tierCount * getContainerTeuFactor(this.containerSize)
    this.capacityTeu = Math.max(Math.round(autoCapacity * 100) / 100, 1)
  }

  this.capacityTeu = Math.max(Number(this.capacityTeu) || 1, 1)
  this.sortOrder = Number(this.sortOrder) || 0
})

export default mongoose.model("YardArea", yardAreaSchema)
