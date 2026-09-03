const multer = require("multer");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");

// Ensure upload directory exists
const uploadDir = process.env.UPLOAD_PATH || "./uploads";
const slipUploadDir = path.join(uploadDir, "payment_slips");

if (!fs.existsSync(slipUploadDir)) {
  fs.mkdirSync(slipUploadDir, { recursive: true });
}

// Configure storage for payment slips
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    let uploadPath = slipUploadDir;

    // Get loan code from request body
    let loanCode = req.body.loan_code || req.body.loanCode || "unknown";
    // Sanitize loan code for folder name
    loanCode = loanCode.replace(/[^a-zA-Z0-9-_]/g, "-");

    // Create subfolder: uploads/payment_slips/{loan_code}/
    uploadPath = path.join(slipUploadDir, loanCode);

    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }

    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

// File filter for payment slips
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
  ];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        "Invalid file type. Only JPEG, PNG, GIF, WebP, and PDF are allowed.",
      ),
      false,
    );
  }
};

// Multer upload instance for single file
const uploadSlip = multer({
  storage: storage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5242880, // 5MB default
  },
  fileFilter: fileFilter,
}).single("slip");

// Multer upload instance for multiple files
const uploadSlips = multer({
  storage: storage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5242880,
  },
  fileFilter: fileFilter,
}).array("slips", 5);

module.exports = {
  uploadSlip,
  uploadSlips,
  slipUploadDir,
};
