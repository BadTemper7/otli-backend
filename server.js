require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// MongoDB Connection
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/testdb";

mongoose
  .connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("✅ Connected to MongoDB successfully!");
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });

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
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    mongodb:
      mongoose.connection.readyState === 1 ? "connected" : "disconnected",
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
// The existing test server and app.listen setup remain unchanged.
const authRoutes = require("./routes/authRoutes.js").default;
const adminRoutes = require("./routes/adminRoutes.js").default;
const clientRoutes = require("./routes/clientRoutes.js").default;
const { getPublicBookingByNumber } = require("./controllers/bookingController.js");
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
    message: err.message,
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`🔗 Test the API: http://localhost:${PORT}/api/test`);
});
