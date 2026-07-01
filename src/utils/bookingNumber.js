import Booking from "../models/Booking.js"
import PreAdvice from "../models/PreAdvice.js"

export const buildBookingNumber = async () => {
  const today = new Date()
  const yyyy = today.getFullYear()
  const mm = String(today.getMonth() + 1).padStart(2, "0")
  const dd = String(today.getDate()).padStart(2, "0")
  const dateCode = `${yyyy}${mm}${dd}`
  const prefix = `BN-${dateCode}-`

  const [bookingCount, preAdviceCount] = await Promise.all([
    Booking.countDocuments({ bookingNumber: { $regex: `^${prefix}` } }),
    PreAdvice.countDocuments({ bookingNumber: { $regex: `^${prefix}` } }),
  ])

  let sequence = bookingCount + preAdviceCount + 1

  while (true) {
    const value = `${prefix}${String(sequence).padStart(5, "0")}`
    const [existingBooking, existingPreAdvice] = await Promise.all([
      Booking.exists({ bookingNumber: value }),
      PreAdvice.exists({ bookingNumber: value }),
    ])

    if (!existingBooking && !existingPreAdvice) return value
    sequence += 1
  }
}
