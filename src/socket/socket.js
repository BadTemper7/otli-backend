import { Server } from "socket.io"
import jwt from "jsonwebtoken"
import User from "../models/User.js"

let ioInstance = null

export const initSocket = (httpServer, allowedOrigins = []) => {
  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins.length ? allowedOrigins : true,
      credentials: true,
    },
  })

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token

      if (!token) return next(new Error("Socket token is missing."))

      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      const user = await User.findById(decoded.id)

      const canUseSocket = user
        ? user.userType === "admin"
          ? user.status === "active"
          : ["active", "verified", "pending", "resubmitted", "rejected"].includes(user.status)
        : false

      if (!canUseSocket) {
        return next(new Error("Socket user is not authorized."))
      }

      socket.user = {
        id: String(user._id),
        email: user.email,
        role: user.role,
        userType: user.userType,
      }

      next()
    } catch (error) {
      next(new Error("Invalid socket token."))
    }
  })

  io.on("connection", (socket) => {
    socket.join(`user:${socket.user.id}`)

    if (socket.user.userType === "admin") socket.join("admins")
    if (socket.user.userType === "client") socket.join("clients")

    socket.emit("socket:connected", {
      message: "Real-time connection established.",
      user: socket.user,
    })

    socket.on("disconnect", () => {})
  })

  ioInstance = io
  return io
}

export const getIO = () => ioInstance

export const emitToAdmins = (event, payload) => {
  if (!ioInstance) return
  ioInstance.to("admins").emit(event, payload)
}

export const emitToUser = (userId, event, payload) => {
  if (!ioInstance || !userId) return
  ioInstance.to(`user:${userId}`).emit(event, payload)
}
