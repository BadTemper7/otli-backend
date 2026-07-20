import "dotenv/config";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";

const require = createRequire(import.meta.url);
const { connectDB } = require("./config/db.js");
const { ensureDocumentsRoot, DOCUMENTS_ROOT } = require("./utils/localFileStorage.js");
const { initSocket } = require("./socket/socket.js");
const { notFound, errorHandler } = require("./middleware/errorHandler.js");
const authRoutesModule = require("./routes/authRoutes.js");
const adminRoutesModule = require("./routes/adminRoutes.js");
const clientRoutesModule = require("./routes/clientRoutes.js");

const authRoutes = authRoutesModule.default || authRoutesModule;
const adminRoutes = adminRoutesModule.default || adminRoutesModule;
const clientRoutes = clientRoutesModule.default || clientRoutesModule;

const app = express();
const httpServer = createServer(app);
const PORT = Number(process.env.PORT || 5000);

const allowedOrigins = [
  process.env.CLIENT_PUBLIC_URL,
  process.env.ADMIN_PUBLIC_URL,
  ...(process.env.CLIENT_ORIGINS || "").split(","),
  ...(process.env.ADMIN_ORIGINS || "").split(","),
  ...(process.env.CORS_ORIGINS || "").split(","),
]
  .map((origin) => String(origin || "").trim().replace(/\/$/, ""))
  .filter(Boolean);

const isAllowedOrigin = (origin) => {
  if (!origin || allowedOrigins.length === 0) return true;
  return allowedOrigins.includes(String(origin).replace(/\/$/, ""));
};

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS."));
  },
  credentials: true,
}));
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.use(cookieParser());
if (process.env.NODE_ENV !== "test") app.use(morgan("combined"));

await ensureDocumentsRoot();
app.use("/documents", express.static(DOCUMENTS_ROOT, {
  dotfiles: "deny",
  index: false,
  fallthrough: true,
  maxAge: 0,
  setHeaders(res) {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("X-Content-Type-Options", "nosniff");
  },
}));

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "OneTrue API is running.",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({
    success: connected,
    status: connected ? "healthy" : "degraded",
    mongodb: connected ? "connected" : "disconnected",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/client", clientRoutes);
app.use(notFound);
app.use(errorHandler);

initSocket(httpServer, allowedOrigins);

const startServer = async () => {
  await connectDB();
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`OneTrue API listening on port ${PORT}`);
  });
};

startServer().catch((error) => {
  console.error("Unable to start OneTrue API:", error.message);
  process.exit(1);
});

const shutdown = async (signal) => {
  console.log(`${signal} received. Closing server...`);
  httpServer.close(async () => {
    await mongoose.connection.close().catch(() => null);
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});
