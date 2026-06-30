import dotenv from "dotenv"
import http from "http"

dotenv.config()

const { default: app, getAllowedOrigins } = await import("./app.js")
const { connectDB } = await import("./config/db.js")
const { initSocket } = await import("./socket/socket.js")

const PORT = process.env.PORT || 5000

await connectDB()

const httpServer = http.createServer(app)
initSocket(httpServer, getAllowedOrigins())

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
  console.log("Socket.IO real-time server enabled")
})
