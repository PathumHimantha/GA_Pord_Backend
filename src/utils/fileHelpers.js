const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const unlinkAsync = promisify(fs.unlink);

const deleteFile = async (filePath) => {
  if (!filePath) return;

  // Remove leading slash if present
  const cleanPath = filePath.startsWith("/") ? filePath.substring(1) : filePath;
  const fullPath = path.join(__dirname, "../../", cleanPath);

  try {
    if (fs.existsSync(fullPath)) {
      // Wait a moment to ensure file is not in use
      await new Promise((resolve) => setTimeout(resolve, 100));

      let retries = 3;
      while (retries > 0) {
        try {
          await unlinkAsync(fullPath);
          console.log("Deleted file:", fullPath);
          break;
        } catch (error) {
          retries--;
          if (retries === 0) {
            console.error(
              "Failed to delete file after retries:",
              fullPath,
              error,
            );
          } else {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
      }
    }
  } catch (error) {
    console.error("Error deleting file:", fullPath, error);
  }
};

const deleteMultipleFiles = async (filePaths) => {
  if (!filePaths || !Array.isArray(filePaths)) return;

  const deletePromises = filePaths.map((filePath) => deleteFile(filePath));
  await Promise.allSettled(deletePromises);
};

const getFileUrl = (filename, category = "", productId = "") => {
  if (!filename) return null;

  // If filename already contains /uploads, return as is
  if (filename.startsWith("/uploads/")) {
    return filename;
  }

  // Build URL with category and productId
  const sanitizedCategory = category.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const sanitizedProductId = productId.toLowerCase().replace(/[^a-z0-9]/g, "-");

  return `/uploads/products/${sanitizedCategory}/${sanitizedProductId}/${filename}`;
};

const isFileExists = (filePath) => {
  if (!filePath) return false;
  const cleanPath = filePath.startsWith("/") ? filePath.substring(1) : filePath;
  const fullPath = path.join(__dirname, "../../", cleanPath);
  return fs.existsSync(fullPath);
};

// Delete entire product folder
const deleteProductImages = async (category, productId) => {
  try {
    const sanitizedCategory = category.toLowerCase().replace(/[^a-z0-9]/g, "-");
    const sanitizedProductId = productId
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-");
    const folderPath = path.join(
      __dirname,
      "../../uploads/products",
      sanitizedCategory,
      sanitizedProductId,
    );

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
      console.log("Deleted product folder:", folderPath);
      return true;
    }
    return false;
  } catch (error) {
    console.error("Error deleting product images:", error);
    return false;
  }
};

module.exports = {
  deleteFile,
  deleteMultipleFiles,
  getFileUrl,
  isFileExists,
  deleteProductImages,
};
