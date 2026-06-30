import dotenv from "dotenv"
import mongoose from "mongoose"
import User from "../models/User.js"
import { getAllAccessPermissions } from "../utils/permissions.js"

dotenv.config()

const seedSuperAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI)

    const email = process.env.SUPER_ADMIN_EMAIL?.toLowerCase().trim()

    if (!email) throw new Error("SUPER_ADMIN_EMAIL is missing in .env")
    if (!process.env.SUPER_ADMIN_PASSWORD) throw new Error("SUPER_ADMIN_PASSWORD is missing in .env")

    const existing = await User.findOne({ email })

    if (existing) {
      existing.name = process.env.SUPER_ADMIN_NAME || "Super Admin"
      existing.userType = "admin"
      existing.role = "super_admin"
      existing.status = "active"
      existing.isEmailVerified = true
      existing.isLockedSeed = true
      existing.permissions = getAllAccessPermissions()
      existing.password = process.env.SUPER_ADMIN_PASSWORD

      await existing.save()
      console.log("Locked Super Admin updated successfully.")
      process.exit(0)
    }

    await User.create({
      name: process.env.SUPER_ADMIN_NAME || "Super Admin",
      email,
      password: process.env.SUPER_ADMIN_PASSWORD,
      userType: "admin",
      role: "super_admin",
      status: "active",
      isEmailVerified: true,
      isLockedSeed: true,
      permissions: getAllAccessPermissions(),
    })

    console.log("Locked Super Admin seeded successfully.")
    process.exit(0)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

seedSuperAdmin()
