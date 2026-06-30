import User from "../models/User.js"
import { safeUser } from "./authController.js"
import { emitToAdmins, emitToUser } from "../socket/socket.js"
import { getAllAccessPermissions, normalizePermissions } from "../utils/permissions.js"

export const listUsers = async (req, res) => {
  const { userType, status, search } = req.query

  const filter = {}
  if (userType) filter.userType = userType
  if (status) filter.status = status

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { companyName: { $regex: search, $options: "i" } },
    ]
  }

  const users = await User.find(filter).sort({ createdAt: -1 })

  return res.json({
    success: true,
    users: users.map(safeUser),
  })
}


export const listClients = async (req, res) => {
  req.query.userType = "client"
  return listUsers(req, res)
}

export const getUserById = async (req, res) => {
  const user = await User.findById(req.params.id)

  if (!user) {
    return res.status(404).json({ success: false, message: "User not found." })
  }

  return res.json({ success: true, user: safeUser(user) })
}

export const createAdminUser = async (req, res) => {
  const { name, email, password, role, permissions } = req.body

  if (!name || !email || !password) {
    return res.status(400).json({ success: false, message: "Name, email, and password are required." })
  }

  const exists = await User.findOne({ email: email.toLowerCase().trim() })
  if (exists) {
    return res.status(409).json({ success: false, message: "Email already exists." })
  }

  const selectedRole = role || "admin"

  const admin = await User.create({
    name,
    email: email.toLowerCase().trim(),
    password,
    userType: "admin",
    role: selectedRole,
    status: "active",
    isEmailVerified: true,
    permissions: selectedRole === "super_admin" ? getAllAccessPermissions() : normalizePermissions(permissions),
  })

  emitToAdmins("admin:user_created", safeUser(admin))

  return res.status(201).json({
    success: true,
    message: "Admin account created successfully.",
    user: safeUser(admin),
  })
}

export const updateUser = async (req, res) => {
  const user = await User.findById(req.params.id)

  if (!user) {
    return res.status(404).json({ success: false, message: "User not found." })
  }

  const {
    name,
    email,
    status,
    role,
    permissions,
    companyName,
    companyAddress,
    phoneNumber,
    representativeFirstName,
    representativeMiddleName,
    representativeLastName,
    representativePosition,
  } = req.body

  if (user.isLockedSeed) {
    user.name = name || user.name
  } else {
    user.name = name ?? user.name
    user.email = email ? email.toLowerCase().trim() : user.email
    user.status = status ?? user.status
    user.role = role ?? user.role

    if (user.userType === "admin") {
      user.permissions = user.role === "super_admin" ? getAllAccessPermissions() : normalizePermissions(permissions || user.permissions)
    }
  }

  user.companyName = companyName ?? user.companyName
  user.companyAddress = companyAddress ?? user.companyAddress
  user.phoneNumber = phoneNumber ?? user.phoneNumber
  user.representativeFirstName = representativeFirstName ?? user.representativeFirstName
  user.representativeMiddleName = representativeMiddleName ?? user.representativeMiddleName
  user.representativeLastName = representativeLastName ?? user.representativeLastName
  user.representativePosition = representativePosition ?? user.representativePosition

  await user.save()

  const payload = safeUser(user)
  emitToAdmins("admin:user_updated", payload)
  emitToUser(user._id, "account:updated", payload)

  return res.json({ success: true, message: "User updated successfully.", user: payload })
}

export const deleteUser = async (req, res) => {
  const user = await User.findById(req.params.id)

  if (!user) {
    return res.status(404).json({ success: false, message: "User not found." })
  }

  if (user.isLockedSeed) {
    return res.status(403).json({ success: false, message: "The seeded Super Admin account cannot be deleted." })
  }

  await User.deleteOne({ _id: user._id })

  emitToAdmins("admin:user_deleted", { id: user._id })

  return res.json({ success: true, message: "User deleted successfully." })
}

export const approveClient = async (req, res) => {
  const user = await User.findById(req.params.id)

  if (!user || user.userType !== "client") {
    return res.status(404).json({ success: false, message: "Client not found." })
  }

  user.status = "verified"
  user.verifiedAt = new Date()
  user.rejectionReason = ""
  user.rejectedAt = null
  await user.save()

  const payload = safeUser(user)
  emitToAdmins("client:approved", payload)
  emitToUser(user._id, "client:approved", payload)

  return res.json({ success: true, message: "Client verified successfully.", user: payload })
}

export const rejectClient = async (req, res) => {
  const user = await User.findById(req.params.id)

  if (!user || user.userType !== "client") {
    return res.status(404).json({ success: false, message: "Client not found." })
  }

  const { reason } = req.body

  user.status = "rejected"
  user.rejectionReason = reason || "Client registration was rejected by admin."
  user.rejectedAt = new Date()
  await user.save()

  const payload = safeUser(user)
  emitToAdmins("client:rejected", payload)
  emitToUser(user._id, "client:rejected", payload)

  return res.json({ success: true, message: "Client rejected successfully.", user: payload })
}
