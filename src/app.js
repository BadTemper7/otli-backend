import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import authRoutes from "./routes/authRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import clientRoutes from "./routes/clientRoutes.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { getPublicBookingByNumber } from "./controllers/bookingController.js";
import asyncHandler from "./utils/asyncHandler.js";

const normalizeOrigin = (value = "") => {
  const origin = String(value).trim().replace(/\/+$/, "");
  if (!origin) return "";

  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
};

export const getAllowedOrigins = () => {
  const configuredOrigins = String(process.env.CLIENT_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

  const developmentOrigins =
    process.env.NODE_ENV === "production"
      ? []
      : ["http://localhost:5173", "http://127.0.0.1:5173"];

  return [...new Set([...configuredOrigins, ...developmentOrigins])];
};

const app = express();

// Hostinger places the application behind a reverse proxy.
app.set("trust proxy", 1);

const allowedOrigins = getAllowedOrigins();
const corsOptions = {
  origin(origin, callback) {
    // Requests without Origin include health checks and server-to-server calls.
    if (!origin) return callback(null, true);

    const normalizedRequestOrigin = normalizeOrigin(origin);
    if (allowedOrigins.includes(normalizedRequestOrigin)) {
      return callback(null, true);
    }

    console.warn(`Blocked CORS origin: ${normalizedRequestOrigin}`);
    return callback(new Error(`Origin ${normalizedRequestOrigin} is not allowed by CORS.`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.use(helmet());
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== "test") {
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "OTLI API is running.",
    health: "/api/health",
  });
});

app.get("/api/health", (req, res) => {
  const databaseConnected = mongoose.connection.readyState === 1;

  // Liveness endpoint: return 200 while the Node.js process is available so
  // Hostinger does not restart the app during a temporary database outage.
  res.status(200).json({
    success: true,
    status: databaseConnected ? "healthy" : "degraded",
    message: databaseConnected
      ? "OTLI API and database are running."
      : "OTLI API is running while MongoDB reconnects.",
    database: databaseConnected ? "connected" : "disconnected",
    environment: process.env.NODE_ENV || "development",
  });
});

app.get("/api/readiness", (req, res) => {
  const databaseConnected = mongoose.connection.readyState === 1;

  res.status(databaseConnected ? 200 : 503).json({
    success: databaseConnected,
    ready: databaseConnected,
    message: databaseConnected
      ? "OTLI API is ready to receive database-backed requests."
      : "OTLI API is online, but MongoDB is not ready yet.",
    database: databaseConnected ? "connected" : "disconnected",
  });
});

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/client", clientRoutes);

app.get(
  "/api/bookings/status/:bookingNumber",
  asyncHandler(getPublicBookingByNumber),
);
app.get(
  "/api/public/bookings/:bookingNumber",
  asyncHandler(getPublicBookingByNumber),
);

app.use(notFound);
app.use(errorHandler);

export default app;
