import jwt from "jsonwebtoken"
import User from "../models/User.js"

export const CLIENT_LOGIN_ALLOWED_STATUSES = ["active", "verified", "pending", "resubmitted", "rejected"]
export const CLIENT_VERIFIED_STATUSES = ["active", "verified"]

const canUseToken = (user) => {
  if (user.userType === "admin") return user.status === "active"
  if (user.userType === "client") return CLIENT_LOGIN_ALLOWED_STATUSES.includes(user.status)
  return false
}

export const protect = async (req, res, next) => {
  try {
    let token = null

    if (req.headers.authorization?.startsWith("Bearer ")) {
      token = req.headers.authorization.split(" ")[1]
    }

    if (!token) {
      return res.status(401).json({ success: false, message: "Not authorized. No token provided." })
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const user = await User.findById(decoded.id)

    if (!user) {
      return res.status(401).json({ success: false, message: "User not found." })
    }

    if (!canUseToken(user)) {
      return res.status(403).json({ success: false, message: `Account is ${user.status}.` })
    }

    req.user = user
    next()
  } catch (error) {
    return res.status(401).json({ success: false, message: "Not authorized. Invalid token." })
  }
}

export const adminOnly = (req, res, next) => {
  if (!req.user || req.user.userType !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access only." })
  }

  next()
}

export const clientOnly = (req, res, next) => {
  if (!req.user || req.user.userType !== "client") {
    return res.status(403).json({ success: false, message: "Client access only." })
  }

  next()
}

export const verifiedClientOnly = (req, res, next) => {
  if (!req.user || req.user.userType !== "client") {
    return res.status(403).json({ success: false, message: "Client access only." })
  }

  if (!CLIENT_VERIFIED_STATUSES.includes(req.user.status)) {
    return res.status(403).json({
      success: false,
      code: "CLIENT_NOT_VERIFIED",
      status: req.user.status,
      message: "Your account is not yet verified. Please wait for admin approval before using this module.",
    })
  }

  next()
}

export const superAdminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== "super_admin") {
    return res.status(403).json({ success: false, message: "Super admin access only." })
  }

  next()
}

export const requirePermission = (moduleName, action = "view") => {
  return (req, res, next) => {
    // Super Admin and Admin are operational roles.
    // Staff accounts still use the per-module permission matrix.
    if (["super_admin", "admin"].includes(req.user?.role)) return next()

    const allowed = Boolean(req.user?.permissions?.[moduleName]?.[action])

    if (!allowed) {
      return res.status(403).json({
        success: false,
        message: `Missing ${action} permission for ${moduleName}.`,
      })
    }

    next()
  }
}
