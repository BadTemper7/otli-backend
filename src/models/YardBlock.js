import mongoose from "mongoose"

const yardBlockSchema = new mongoose.Schema(
  {
    area: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "YardArea",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    blockType: {
      type: String,
      enum: ["standard", "reefer", "empty", "laden", "inspection", "hold"],
      default: "standard",
    },
    bayCount: {
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
    teuSlots: {
      type: Number,
      default: 1,
      min: 1,
    },
    occupiedSlots: {
      type: Number,
      default: 0,
      min: 0,
    },
    x: {
      type: Number,
      default: 40,
      min: 0,
    },
    y: {
      type: Number,
      default: 40,
      min: 0,
    },
    width: {
      type: Number,
      default: 170,
      min: 60,
    },
    height: {
      type: Number,
      default: 90,
      min: 40,
    },
    rotation: {
      type: Number,
      default: 0,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "maintenance", "full"],
      default: "active",
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true }
)

const getContainerTeuFactor = (size) => {
  if (Number(size) === 40) return 2
  if (Number(size) === 45) return 3
  return 1
}

yardBlockSchema.index({ area: 1, code: 1 }, { unique: true })

yardBlockSchema.pre("validate", function () {
  if (this.code) this.code = this.code.toUpperCase().trim()

  this.bayCount = Math.max(Number(this.bayCount) || 1, 1)
  this.rowCount = Math.max(Number(this.rowCount) || 1, 1)
  this.tierCount = Math.max(Number(this.tierCount) || 1, 1)
  this.containerSize = [20, 40, 45].includes(Number(this.containerSize)) ? Number(this.containerSize) : 20

  if (!this.teuSlots || Number(this.teuSlots) < 1) {
    const autoCapacity = this.bayCount * this.rowCount * this.tierCount * getContainerTeuFactor(this.containerSize)
    this.teuSlots = Math.max(Math.round(autoCapacity * 100) / 100, 1)
  }

  this.teuSlots = Math.max(Number(this.teuSlots) || 1, 1)
  this.occupiedSlots = Math.min(Math.max(Number(this.occupiedSlots) || 0, 0), this.teuSlots)
  this.x = Math.max(Number(this.x) || 0, 0)
  this.y = Math.max(Number(this.y) || 0, 0)
  this.width = Math.max(Number(this.width) || 170, 60)
  this.height = Math.max(Number(this.height) || 90, 40)
  this.rotation = Number(this.rotation) || 0
  this.sortOrder = Number(this.sortOrder) || 0
})

export default mongoose.model("YardBlock", yardBlockSchema)
