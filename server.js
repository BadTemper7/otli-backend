// Seed manually with: npm run seed. Do not seed during API startup.
require("dotenv").config();

// Respect the host OS DNS resolvers. Forcing public DNS servers globally can
// break Atlas SRV lookups on networks that block external DNS traffic.
// If DNS resolution fails, confirm Hostinger/Atlas networking in runtime logs.


const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
// Fail fast when MongoDB disconnects rather than buffering requests until
// browser timeouts. The database-availability middleware returns HTTP 503.
mongoose.set("bufferCommands", false);
const cors = require("cors");
const { createCorsPolicy } = require("./config/cors.js");
const path = require("path");
const {
  ensureDocumentsRoot,
  getDocumentsStorageStatus,
  DOCUMENTS_ROOT,
} = require("./utils/localFileStorage.js");

const app = express();
const PORT = process.env.PORT || 3000;
const { createApiDiagnostics } = require("./middleware/apiDiagnostics.js");
const { createDatabaseAvailability } = require("./middleware/databaseAvailability.js");
const { createApiErrorHandler } = require("./middleware/apiErrorResponse.js");

// Apply one CORS policy to HTTP requests and Socket.IO. In local
// development any origin is allowed; other modes use an exact allowlist.
const corsPolicy = createCorsPolicy();
app.use(cors(corsPolicy.corsOptions));
app.use(createApiDiagnostics({ getDatabaseState: () => mongoose.connection.readyState }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// All database-dependent endpoints return a quick 503 if Atlas disconnects.
// /api/test remains accessible to distinguish backend availability from DB health.
app.use("/api", createDatabaseAvailability(() => mongoose.connection.readyState));

// Local document storage. Client folders are created automatically on upload.
// Storage is initialized again during server bootstrap before accepting requests.
app.use(
  "/documents",
  express.static(DOCUMENTS_ROOT, {
    dotfiles: "deny",
    index: false,
    fallthrough: true,
    maxAge: 0,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  }),
);

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

// Optional, read-only diagnostic: distinguishes a healthy MongoDB connection
// from one which is stuck waiting for a database server. 3s maximum reply.
const { probeDatabase } = require("./utils/databaseHealth.js");
app.get("/health/database", async (_req, res) => {
  const result = await probeDatabase(mongoose.connection);
  res.setHeader("Cache-Control", "no-store");
  res.status(result.healthy ? 200 : 503).json({
    status: result.healthy ? "healthy" : "degraded",
    mongodb: result.mongodb,
    latencyMs: result.latencyMs,
  });
});

// ===== User Routes =====

// Create a new user
app.post("/api/users", async (req, res) => {
  try {
    const { name, email, age } = req.body;

    // Validation
    if (!name || !email) {
      return res.status(400).json({
        error: "Name and email are required",
      });
    }

    const user = new User({ name, email, age });
    await user.save();

    res.status(201).json({
      success: true,
      message: "User created successfully",
      user,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        error: "Email already exists",
      });
    }
    res.status(500).json({
      error: error.message,
    });
  }
});

// Get all users
app.get("/api/users", async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json({
      success: true,
      count: users.length,
      users,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

// Get a single user by ID
app.get("/api/users/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        error: "User not found",
      });
    }
    res.json({
      success: true,
      user,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

// Update a user
app.put("/api/users/:id", async (req, res) => {
  try {
    const { name, email, age } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { name, email, age },
      { new: true, runValidators: true },
    );

    if (!user) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    res.json({
      success: true,
      message: "User updated successfully",
      user,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

// Delete a user
app.delete("/api/users/:id", async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) {
      return res.status(404).json({
        error: "User not found",
      });
    }
    res.json({
      success: true,
      message: "User deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

// ===== Test Route =====
app.get("/api/test", (req, res) => {
  res.json({
    message: "API is working!",
    endpoints: [
      { method: "GET", path: "/" },
      { method: "GET", path: "/health" },
      { method: "GET", path: "/api/users" },
      { method: "POST", path: "/api/users" },
      { method: "GET", path: "/api/users/:id" },
      { method: "PUT", path: "/api/users/:id" },
      { method: "DELETE", path: "/api/users/:id" },
      { method: "GET", path: "/api/test" },
    ],
  });
});

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

// Error Handler: distinguish transient MongoDB failures from application errors.
// Never return raw connection strings, credentials or internal stack traces.
app.use(createApiErrorHandler());

// Avoid noisy and potentially sensitive raw driver error output.
mongoose.connection.on("disconnected", () => console.warn("[database] MongoDB connection lost"));
mongoose.connection.on("reconnected", () => console.info("[database] MongoDB connection restored"));
mongoose.connection.on("error", (error) =>
  console.error(`[database] connection error type=${String(error?.name || "Error").slice(0, 80)}`),
);

// Start HTTP and Socket.IO server
const { initSocket } = require("./socket/socket.js");
const httpServer = http.createServer(app);
initSocket(httpServer, corsPolicy.corsOptions);

const { createDatabaseConnector } = require("./utils/runtimeStartup.js");

const repairLegacySpecialRatesIndex = async () => {
  try {
    const collection = mongoose.connection.collection("specialrates");
    const indexes = await collection.indexes();
    for (const index of indexes) {
      const keys = index?.key || {};
      if (
        keys.clients !== undefined &&
        keys["transactions.transactionKey"] !== undefined
      ) {
        await collection.dropIndex(index.name);
        console.info(`[database] Removed legacy Special Rate index: ${index.name}`);
      }
    }
  } catch (error) {
    if (error?.codeName !== "NamespaceNotFound" && error?.code !== 26) {
      // Index cleanup is maintenance, not a reason for the whole API to crash.
      console.warn(`[database] Legacy index check skipped type=${error?.name || "Error"}`);
    }
  }
};

const dbConnector = createDatabaseConnector({
  connect: () => mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    waitQueueTimeoutMS: 5000,
    maxPoolSize: 15,
    maxIdleTimeMS: 60000,
  }),
  afterConnect: repairLegacySpecialRatesIndex,
});

// Listen immediately so Hostinger can route health checks to this process.
// MongoDB-dependent endpoints return an explicit 503 until Atlas is ready.
// A transient Atlas connection failure no longer terminates Express.
const startServer = () => {
  httpServer.listen(PORT, () => {
    console.info(`[startup] HTTP listening port=${PORT} env=${process.env.NODE_ENV || "development"}`);
    console.info(`[startup] API probe: http://localhost:${PORT}/api/test`);
    if (!process.env.JWT_SECRET) {
      console.error("[startup] JWT_SECRET is not configured; authentication cannot work.");
    }
    void ensureDocumentsRoot()
      .then(() => console.info("[storage] Documents directory ready"))
      .catch((error) => console.warn(`[storage] Documents unavailable type=${error?.name || "Error"}`));

    if (process.env.NODE_ENV === "production" && !process.env.MONGODB_URI) {
      console.error("[startup] MONGODB_URI is missing. Database routes are unavailable.");
    } else {
      dbConnector.start();
    }
  });
};

httpServer.on("error", (error) => {
  console.error(`[startup] HTTP server error type=${error?.code || error?.name || "Error"}`);
  process.exitCode = 1;
});

startServer();
