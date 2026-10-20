// Seed manually with: npm run seed. Do not seed during API startup.
require("dotenv").config();
const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const {
  ensureDocumentsRoot,
  getDocumentsStorageStatus,
  DOCUMENTS_ROOT,
} = require("./utils/localFileStorage.js");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
const allowedOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",").map(x => x.trim()).filter(Boolean);
if (process.env.NODE_ENV === "production" && !allowedOrigins.length) {
  throw new Error("CORS_ORIGINS must be configured in production.");
}
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
app.disable("x-powered-by");
app.use(require("helmet")());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Documents must never be served anonymously. Access is restricted to the
// owning client or an active administrator. Authentication is via Bearer token.
const fs = require("fs");
const { protect } = require("./middleware/authMiddleware.js");
const { resolveStoredFilePath } = require("./utils/localFileStorage.js");
app.get("/documents/:owner/:file", protect, async (req, res) => {
  const owner = String(req.params.owner);
  const isAdmin = req.user.userType === "admin" && req.user.status === "active";
  if (!isAdmin && (req.user.userType !== "client" || String(req.user._id) !== owner)) {
    return res.status(403).json({ success: false, message: "Document access denied." });
  }
  const filePath = resolveStoredFilePath(`${owner}/${req.params.file}`);
  if (!filePath) return res.sendStatus(404);
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return res.sendStatus(404);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "attachment");
    return res.sendFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return res.sendStatus(404);
    return res.sendStatus(500);
  }
});

// MongoDB Connection
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/testdb";


// ==================== MODELS ====================

// User Schema
const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  age: {
    type: Number,
    min: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const User = mongoose.model("TestUser", userSchema);

// ==================== ROUTES ====================

// Health Check (Important for Hostinger)
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    message: "🚀 Server is running successfully!",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  });
});

// Health check endpoint
app.get("/health", async (req, res) => {
  const documentStorage = await getDocumentsStorageStatus();
  const databaseConnected = mongoose.connection.readyState === 1;
  const healthy = databaseConnected && documentStorage.ready;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "healthy" : "degraded",
    mongodb: databaseConnected ? "connected" : "disconnected",
    documentStorage,
    uptime: process.uptime(),
  });
});

// Legacy unauthenticated sample-user CRUD routes removed: they exposed
// personal records and allowed anonymous modification/deletion.
app.get("/api/test", (req, res) => res.json({ status: "OK" }));

// ==================== ONETRUE BACKEND ====================
// OneTrue folders are kept directly in the project root.
// The OneTrue API and Socket.IO share the same HTTP server.
const authRoutes = require("./routes/authRoutes.js").default;
const adminRoutes = require("./routes/adminRoutes.js").default;
const clientRoutes = require("./routes/clientRoutes.js").default;
const {
  getPublicBookingByNumber,
} = require("./controllers/bookingController.js");
const asyncHandler = require("./utils/asyncHandler.js").default;

app.use("/api/auth", authRoutes);
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

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
  });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error("Error:", err.stack);
  res.status(500).json({
    error: "Something went wrong!",
    message: process.env.NODE_ENV === "production" ? "Request failed." : err.message,
  });
});

// Start HTTP and Socket.IO server
const { initSocket } = require("./socket/socket.js");
const httpServer = http.createServer(app);
const socketAllowedOrigins = String(
  process.env.SOCKET_ALLOWED_ORIGINS || process.env.CORS_ORIGINS || "",
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

initSocket(httpServer, socketAllowedOrigins);

const startServer = async () => {
  const storagePath = await ensureDocumentsRoot();
  console.log(`📁 Document storage ready: ${storagePath}`);

  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log("✅ Connected to MongoDB successfully!");

  // MongoDB cannot maintain a compound multikey index that includes two
  // array fields. Older deployments created an index containing both
  // `clients` and `transactions.transactionKey`, which causes inserts such as
  // a Special Rate with multiple clients/transactions to fail with:
  // "cannot index parallel arrays [clients] [transactions]".
  //
  // Remove only that legacy invalid index. The schema now keeps two safe
  // indexes instead: one starting with `clients`, and another starting with
  // `transactions.transactionKey`.
  try {
    const specialRatesCollection = mongoose.connection.collection("specialrates");
    const indexes = await specialRatesCollection.indexes();

    for (const index of indexes) {
      const keys = index?.key || {};
      if (keys.clients !== undefined && keys["transactions.transactionKey"] !== undefined) {
        console.warn(`Legacy Special Rate index requires reviewed manual migration: ${index.name}`);
      }
    }
  } catch (indexError) {
    // NamespaceNotFound simply means the collection has not been created yet.
    // Do not prevent the API from starting for that case.
    if (indexError?.codeName !== "NamespaceNotFound" && indexError?.code !== 26) {
      throw indexError;
    }
  }

  httpServer.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`🔗 Test the API: http://localhost:${PORT}/api/test`);
    console.log("🔌 Socket.IO is enabled");
  });
};

startServer().catch((error) => {
  console.error("❌ Server startup failed:", error.message);
  if (error?.stack) console.error(error.stack);
  process.exit(1);
});
