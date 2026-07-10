import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import authRoutes from "./routes/authRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import clientRoutes from "./routes/clientRoutes.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { getPublicBookingByNumber } from "./controllers/bookingController.js";
import asyncHandler from "./utils/asyncHandler.js";

export const getAllowedOrigins = () => {
  return (process.env.CLIENT_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
};

const app = express();

// Render and other reverse proxies send X-Forwarded-* headers.
// This keeps express-rate-limit from rejecting proxied production requests.
app.set("trust proxy", 1);

const allowedOrigins = getAllowedOrigins();

// app.use(
//   cors({
//     origin: function (origin, callback) {
//       if (!origin || allowedOrigins.includes(origin))
//         return callback(null, true);
//       return callback(new Error("Not allowed by CORS"));
//     },
//     credentials: true,
//   }),
// );
app.use(cors());

app.use(helmet());
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: "draft-8",
  legacyHeaders: false,
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

app.get("/api/health", (req, res) => {
  res.json({ success: true, message: "OTLI API is running." });
});

app.use(notFound);
app.use(errorHandler);

export default app;
