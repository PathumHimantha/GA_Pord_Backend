const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const { connectDB, pool } = require("./config/database");
const productRoutes = require("./routes/productRoutes");
const cartRoutes = require("./routes/cartRoutes");
const loanRoutes = require("./routes/loanRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const reportRoutes = require("./routes/reportRoutes");
const app = express();
const PORT = process.env.PORT || 5000;
const { initScheduler, getNextRunTime } = require("./scheduler");
// Connect to MySQL
connectDB();

// Middleware
app.use(
  cors({
    origin: [
      "http://localhost:8080",
      "http://localhost:5173",
      "https://your-frontend-domain.com",
    ],
    credentials: true,
  }),
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Serve static files (uploaded images)
app.use("/api/uploads", express.static(path.join(__dirname, "../uploads")));

// Routes
app.use("/api/products", productRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/loans", loanRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/report", reportRoutes);
// Health check with DB connection status s
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "OK",
      message: "Server is running",
      database: "connected",
    });
  } catch (error) {
    res.status(500).json({
      status: "ERROR",
      message: "Server is running but database is not connected",
      database: "disconnected",
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Server Error:", err.stack);

  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      success: false,
      error: "File too large. Maximum size is 5MB.",
    });
  }

  res.status(500).json({
    success: false,
    error:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Internal server error",
  });
});

// Initialize Scheduler AFTER server is ready
let schedulerJob = null;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Static files served from: http://localhost:${PORT}/uploads`);

  // Initialize the scheduler when server starts
  try {
    schedulerJob = initScheduler();
    const nextRun = getNextRunTime();
    console.log(
      `📅 Next scheduler run: ${nextRun.toLocaleString("en-US", { timeZone: "Asia/Colombo" })}`,
    );
  } catch (error) {
    console.error("❌ Failed to initialize scheduler:", error);
  }
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Closing database pool...");
  await pool.end();
  console.log("Database pool closed");

  // Stop the scheduler
  if (schedulerJob) {
    schedulerJob.stop();
    console.log("Scheduler stopped");
  }

  process.exit(0);
});
