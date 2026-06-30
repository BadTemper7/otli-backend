import bcrypt from "bcryptjs"

export const generateOtp = () => String(Math.floor(100000 + Math.random() * 900000))

export const hashOtp = async (otp) => {
  const salt = await bcrypt.genSalt(10)
  return bcrypt.hash(String(otp), salt)
}

export const compareOtp = async (otp, otpHash) => bcrypt.compare(String(otp), otpHash)
