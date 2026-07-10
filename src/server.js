import dotenv from "dotenv"
import http from "http"

dotenv.config()

const { default: app, getAllowedOrigins } = await import("./app.js")
const { connectDB } = await import("./config/db.js")
const { initSocket } = await import("./socket/socket.js")

// Hostinger managed Node.js applications are expected to listen on port 3000.
// Other platforms can still override this by providing their own PORT value.
const PORT = Number.parseInt(process.env.PORT || "3000", 10)
const HOST = process.env.HOST || "0.0.0.0"

const startServer = async () => {
  await connectDB()

  const httpServer = http.createServer(app)
  initSocket(httpServer, getAllowedOrigins())

  httpServer.listen(PORT, HOST, () => {
    console.log(`OTLI API listening on http://${HOST}:${PORT}`)
    console.log("Socket.IO real-time server enabled")
  })

  const shutdown = (signal) => {
    console.log(`${signal} received. Closing HTTP server...`)
    httpServer.close(() => process.exit(0))
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}

startServer().catch((error) => {
  console.error("OTLI server failed to start:", error)
  process.exit(1)
})
