// Seed manually with: npm run seed. Do not seed during API startup.
require("dotenv").config();

// ==================== DNS CONFIG ====================
// Force Node to use reliable public DNS resolvers (e.g. for MongoDB Atlas SRV
// lookups on hosts like Hostinger where the default resolver is unreliable).
const dns = require("dns");
try {
  dns.setServers(["1.1.1.1", "8.8.8.8"]); // Cloudflare + Google
  console.log("🌐 DNS resolvers set:", dns.getServers().join(", "));
} catch (err) {
  console.warn("⚠️  Could not set custom DNS servers:", err.message);
}
// ==================================================

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
app.use(cors());
// Signed provider events need the exact raw bytes. Mount before JSON parsing.
app.post("/api/email/webhook", express.raw({ type: "application/json", limit: "32kb" }), require("./routes/emailPublicRoutes.js").signedWebhook);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

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

app.use("/api/email", require("./routes/emailPublicRoutes.js").router);
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
  // Never echo SMTP/provider/Redis/Mongo exception bodies or stack traces;
  // connection errors can embed credentials or recipient details.
  console.error("API request failed:", err.code || "REQUEST_FAILED", req.path);
  const permittedStatus = Number(err.status);
  const status = Number.isInteger(permittedStatus) && permittedStatus >= 400 && permittedStatus < 500
    ? permittedStatus
    : permittedStatus === 503 ? 503 : 500;
  const safeClientError = status < 500 && typeof err.message === "string"
    ? err.message
    : status === 503 && err.code === "EMAIL_STILL_QUEUED"
      ? "Email is queued but not yet provider-accepted; do not request an immediate duplicate."
      : "Something went wrong!";
  res.status(status).json({ error: status >= 500 ? "Something went wrong!" : "Request rejected", message: safeClientError });
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

  await mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
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
    const specialRatesCollection =
      mongoose.connection.collection("specialrates");
    const indexes = await specialRatesCollection.indexes();

    for (const index of indexes) {
      const keys = index?.key || {};
      if (
        keys.clients !== undefined &&
        keys["transactions.transactionKey"] !== undefined
      ) {
        await specialRatesCollection.dropIndex(index.name);
        console.log(`✅ Removed legacy Special Rate index: ${index.name}`);
      }
    }
  } catch (indexError) {
    // NamespaceNotFound simply means the collection has not been created yet.
    // Do not prevent the API from starting for that case.
    if (
      indexError?.codeName !== "NamespaceNotFound" &&
      indexError?.code !== 26
    ) {
      throw indexError;
    }
  }

  if (process.env.EMAIL_WORKER_ENABLED === "false") {
    const emailCrypto = require("./services/emailCrypto.js");
    emailCrypto.key(); emailCrypto.secret();
    require("./services/emailPolicy.js").policy();
    await require("./services/emailQueue.js").redis().ping();
    await require("./services/emailService.js").ensureRedisQuotaState();
    await require("./services/emailMonitoring.js").ensureIncidentPauses();
  } else {
    await require("./services/emailService.js").startWorkers();
  }
  httpServer.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`🔗 Test the API: http://localhost:${PORT}/api/test`);
    console.log("🔌 Socket.IO is enabled");
  });
};

startServer().catch((error) => {
  // Startup failures can contain connection strings or provider responses.
  // Do not print raw exception messages/stacks containing secret credentials.
  console.error("Server startup failed:", error.code || "INITIALIZATION_ERROR");
  process.exit(1);
});

// Graceful queue shutdown: BullMQ resumes waiting jobs after process restart.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    httpServer.close();
    await require("./services/emailService.js").stopWorkers();
    await require("./services/emailQueue.js").close();
    await mongoose.disconnect();
    process.exit(0);
  });
}
