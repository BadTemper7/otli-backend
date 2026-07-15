import dotenv from "dotenv";
import http from "http";
import mongoose from "mongoose";

dotenv.config();

const { default: app, getAllowedOrigins } = await import("./app.js");
const { connectDB } = await import("./config/db.js");
const { initSocket } = await import("./socket/socket.js");

// Hostinger managed Node.js applications normally expose the PORT value.
// Port 3000 remains the fallback for local use and Hostinger configurations
// that do not inject a custom PORT.
const parsedPort = Number.parseInt(process.env.PORT || "3000", 10);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 3000;
const HOST = process.env.HOST || "0.0.0.0";
const parsedRetryDelay = Number.parseInt(
  process.env.DB_RETRY_DELAY_MS || "30000",
  10,
);
const DB_RETRY_DELAY_MS =
  Number.isInteger(parsedRetryDelay) && parsedRetryDelay >= 5000
    ? parsedRetryDelay
    : 30000;

const httpServer = http.createServer(app);
initSocket(httpServer, getAllowedOrigins());

let databaseRetryTimer = null;
let isShuttingDown = false;

const scheduleDatabaseReconnect = () => {
  if (isShuttingDown || databaseRetryTimer) return;

  databaseRetryTimer = setTimeout(async () => {
    databaseRetryTimer = null;
    await connectDatabase();
  }, DB_RETRY_DELAY_MS);
};

const connectDatabase = async () => {
  if (isShuttingDown || mongoose.connection.readyState === 1) return;

  try {
    await connectDB();
  } catch (error) {
    console.error("MongoDB is unavailable:", error.message);
    console.error(
      `The API is still online. Retrying MongoDB in ${Math.round(
        DB_RETRY_DELAY_MS / 1000,
      )} seconds.`,
    );
    scheduleDatabaseReconnect();
  }
};

const shutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`${signal} received. Closing OTLI API...`);

  if (databaseRetryTimer) {
    clearTimeout(databaseRetryTimer);
    databaseRetryTimer = null;
  }

  const forceExitTimer = setTimeout(() => {
    console.error("Graceful shutdown timed out. Exiting immediately.");
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  httpServer.close(async () => {
    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
    } catch (error) {
      console.error("Error while closing MongoDB:", error.message);
    }

    console.log("OTLI API stopped.");
    process.exit(0);
  });
};

httpServer.on("error", (error) => {
  console.error("HTTP server error:", error);
  process.exit(1);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`OTLI API listening on http://${HOST}:${PORT}`);
  console.log("Socket.IO real-time server enabled");

  // Do not block Hostinger startup while MongoDB is connecting. This keeps
  // the HTTP process alive and allows temporary DNS or Atlas access issues
  // to recover automatically.
  void connectDatabase();
});

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
