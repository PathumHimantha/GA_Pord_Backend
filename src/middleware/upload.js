const multer = require("multer");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const sharp = require("sharp");
const fs = require("fs");
const { promisify } = require("util");
const unlinkAsync = promisify(fs.unlink);

// Ensure upload directory exists
const uploadDir = process.env.UPLOAD_PATH || "./uploads";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Create subdirectories
const createDirectory = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

// Helper to get category and product_id from request
const getUploadPath = (req) => {
  let uploadPath = uploadDir;

  // Get category and product_id from request body
  // For multipart/form-data, body is parsed by multer
  let category = "uncategorized";
  let productId = "temp";

  // Try different ways to get the data
  if (req.body) {
    // Check if data is in req.body directly
    if (req.body.category) category = req.body.category;
    if (req.body.product_id) productId = req.body.product_id;

    // Check if data is in req.body.data (JSON string)
    if (req.body.data) {
      try {
        const parsedData =
          typeof req.body.data === "string"
            ? JSON.parse(req.body.data)
            : req.body.data;
        if (parsedData.category) category = parsedData.category;
        if (parsedData.product_id) productId = parsedData.product_id;
      } catch (e) {
        // If parsing fails, use default
      }
    }
  }

  // Sanitize category and product_id for folder names
  category = category.toLowerCase().replace(/[^a-z0-9]/g, "-");
  productId = productId.toLowerCase().replace(/[^a-z0-9]/g, "-");

  // Create folder structure: uploads/products/category/productId/
  uploadPath = path.join(uploadDir, "products", category, productId);

  // Ensure directory exists
  createDirectory(uploadPath);

  return { uploadPath, category, productId };
};

// Dynamic storage configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const { uploadPath } = getUploadPath(req);
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueName = `${uuidv4()}-${Date.now()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

// File filter
const fileFilter = (req, file, cb) => {
  const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        "Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.",
      ),
      false,
    );
  }
};

// Multer upload instance
const upload = multer({
  storage: storage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5242880, // 5MB default
  },
  fileFilter: fileFilter,
});

// Image processing middleware with dynamic paths
const processImages = async (req, res, next) => {
  if (!req.files || req.files.length === 0) {
    return next();
  }

  try {
    const processedImages = [];
    const { category, productId } = getUploadPath(req);

    for (const file of req.files) {
      try {
        const filePath = file.path;
        const fileName = file.filename;
        const ext = path.extname(fileName);
        const baseName = path.basename(fileName, ext);
        const dirPath = path.dirname(filePath);
        const processedFileName = `${baseName}-processed.jpg`;
        const processedPath = path.join(dirPath, processedFileName);

        // Process image with Sharp
        await sharp(filePath)
          .resize(800, 800, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality: 80 })
          .toFile(processedPath);

        // Wait a moment before deleting original file
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Delete original file with retry
        let retries = 3;
        while (retries > 0) {
          try {
            if (fs.existsSync(filePath)) {
              await unlinkAsync(filePath);
            }
            break;
          } catch (unlinkError) {
            retries--;
            if (retries === 0) {
              console.error(
                "Failed to delete original file after retries:",
                filePath,
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }

        // Get relative path from uploads directory
        const relativePath = path.relative(uploadDir, processedPath);
        const imageUrl = `/uploads/${relativePath.replace(/\\/g, "/")}`;

        processedImages.push(imageUrl);
      } catch (fileError) {
        console.error("Error processing individual file:", fileError);
        // If processing fails, use original file
        const relativePath = path.relative(uploadDir, file.path);
        processedImages.push(`/uploads/${relativePath.replace(/\\/g, "/")}`);
      }
    }

    req.processedImages = processedImages;
    // Store category and productId in request for later use
    req.uploadCategory = category;
    req.uploadProductId = productId;
    next();
  } catch (error) {
    console.error("Image processing error:", error);
    // If processing fails, use original files
    req.processedImages = req.files.map((f) => {
      const relativePath = path.relative(uploadDir, f.path);
      return `/uploads/${relativePath.replace(/\\/g, "/")}`;
    });
    next();
  }
};

// Clean up orphaned files periodically
const cleanupOrphanedFiles = () => {
  try {
    const productsDir = path.join(uploadDir, "products");
    if (!fs.existsSync(productsDir)) return;

    const categories = fs.readdirSync(productsDir);
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

    categories.forEach((category) => {
      const categoryPath = path.join(productsDir, category);
      if (fs.statSync(categoryPath).isDirectory()) {
        const products = fs.readdirSync(categoryPath);
        products.forEach((productId) => {
          const productPath = path.join(categoryPath, productId);
          if (fs.statSync(productPath).isDirectory()) {
            const files = fs.readdirSync(productPath);
            files.forEach((file) => {
              const filePath = path.join(productPath, file);
              const stats = fs.statSync(filePath);
              if (now - stats.mtime.getTime() > maxAge) {
                try {
                  fs.unlinkSync(filePath);
                  console.log("Cleaned up orphaned file:", filePath);
                } catch (err) {
                  console.error("Error cleaning up file:", err);
                }
              }
            });
          }
        });
      }
    });
  } catch (error) {
    console.error("Error during cleanup:", error);
  }
};

// Run cleanup every hour
setInterval(cleanupOrphanedFiles, 60 * 60 * 1000);

// Helper function to get product folder path
const getProductFolderPath = (category, productId) => {
  const sanitizedCategory = category.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const sanitizedProductId = productId.toLowerCase().replace(/[^a-z0-9]/g, "-");
  return path.join(
    uploadDir,
    "products",
    sanitizedCategory,
    sanitizedProductId,
  );
};

// Helper function to delete product folder
const deleteProductFolder = async (category, productId) => {
  try {
    const folderPath = getProductFolderPath(category, productId);
    if (fs.existsSync(folderPath)) {
      // Delete all files in folder
      const files = fs.readdirSync(folderPath);
      for (const file of files) {
        const filePath = path.join(folderPath, file);
        try {
          await unlinkAsync(filePath);
        } catch (err) {
          console.error("Error deleting file:", filePath, err);
        }
      }
      // Delete empty folder
      try {
        fs.rmdirSync(folderPath);
      } catch (err) {
        console.error("Error deleting folder:", folderPath, err);
      }
    }
  } catch (error) {
    console.error("Error deleting product folder:", error);
  }
};

// Add uploadDir to exports
module.exports = {
  upload,
  processImages,
  cleanupOrphanedFiles,
  getProductFolderPath,
  deleteProductFolder,
  uploadDir, // Export uploadDir for use in routes
};
