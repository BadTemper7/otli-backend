import multer from "multer"

const allowedMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
])

const storage = multer.memoryStorage()

const fileFilter = (req, file, cb) => {
  if (!allowedMimeTypes.has(file.mimetype)) {
    return cb(new Error("Only PDF, Word, JPG, PNG, and WEBP files are allowed."))
  }

  cb(null, true)
}

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 8,
  },
})

export const clientRegistrationUpload = upload.fields([
  { name: "businessPermit", maxCount: 1 },
  { name: "birCertificate", maxCount: 1 },
  { name: "validId", maxCount: 1 },
  { name: "authorizationLetter", maxCount: 1 },
  { name: "otherDocument", maxCount: 1 },
])

export const preAdviceUpload = upload.fields([
  { name: "eir", maxCount: 1 },
  { name: "deliveryOrder", maxCount: 1 },
  { name: "bookingConfirmation", maxCount: 1 },
  { name: "packingList", maxCount: 1 },
  { name: "customsClearance", maxCount: 1 },
  { name: "otherDocument", maxCount: 1 },
])

export const bookingPreAdviceUpload = upload.fields([
  { name: "eir", maxCount: 1 },
  { name: "deliveryOrder", maxCount: 1 },
  { name: "bookingConfirmation", maxCount: 1 },
  { name: "packingList", maxCount: 1 },
  { name: "customsClearance", maxCount: 1 },
  { name: "otherDocument", maxCount: 1 },
])


export const bookingPaymentUpload = upload.fields([
  { name: "paymentProof", maxCount: 3 },
  { name: "otherDocument", maxCount: 2 },
])

const paymentTypeImageUpload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      return cb(new Error("QR image must be JPG, PNG, or WEBP."))
    }
    cb(null, true)
  },
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
})

export const paymentTypeUpload = paymentTypeImageUpload.single("qr")
