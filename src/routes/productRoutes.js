const express = require("express");
const router = express.Router();
const Product = require("../models/Product");
const {
  upload,
  processImages,
  deleteProductFolder,
} = require("../middleware/upload");
const {
  deleteMultipleFiles,
  deleteProductImages,
} = require("../utils/fileHelpers");
const {
  executeWithRetry,
  withTransaction,
  searchCache,
} = require("../utils/dbHelpers");
const path = require("path");
const fs = require("fs");
const { uploadDir } = require("../middleware/upload"); // Import uploadDir

// GET all products with pagination and filtering
router.get("/", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      category = "",
      status = "",
      minPrice,
      maxPrice,
      sortBy = "created_at",
      sortOrder = "DESC",
    } = req.query;

    // Create cache key
    const cacheKey = `products_${page}_${limit}_${search}_${category}_${status}_${minPrice}_${maxPrice}_${sortBy}_${sortOrder}`;

    // Check cache
    const cachedResult = searchCache.get(cacheKey);
    if (cachedResult) {
      return res.json({
        success: true,
        data: cachedResult.data,
        pagination: cachedResult.pagination,
        cached: true,
      });
    }

    const result = await Product.findAll({
      page,
      limit,
      search: search.toString(),
      category: category.toString(),
      status: status.toString(),
      minPrice: minPrice ? parseFloat(minPrice) : null,
      maxPrice: maxPrice ? parseFloat(maxPrice) : null,
      sortBy,
      sortOrder,
    });

    // Cache results
    searchCache.set(cacheKey, result);

    res.json({
      success: true,
      data: result.data,
      pagination: result.pagination,
    });
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET single product by ID
router.get("/:id", async (req, res) => {
  try {
    const product = await executeWithRetry(
      'SELECT *, JSON_UNQUOTE(JSON_EXTRACT(images, "$")) as images FROM products WHERE id = ?',
      [req.params.id],
    );

    if (!product || product.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Product not found",
      });
    }

    const productData = product[0];
    productData.images = productData.images
      ? JSON.parse(productData.images)
      : [];

    res.json({ success: true, data: productData });
  } catch (error) {
    console.error("Error fetching product:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET product by product_id
router.get("/code/:product_id", async (req, res) => {
  try {
    const product = await Product.findByProductId(req.params.product_id);

    if (!product) {
      return res.status(404).json({
        success: false,
        error: "Product not found",
      });
    }

    res.json({ success: true, data: product });
  } catch (error) {
    console.error("Error fetching product:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📸 UPLOAD IMAGES ENDPOINT - Updated
router.post(
  "/upload",
  upload.array("images", 10),
  processImages,
  async (req, res) => {
    try {
      // Check if files were uploaded
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          success: false,
          error: "No images provided",
        });
      }

      // Get category and product_id from request (set by processImages)
      let category = req.uploadCategory || "uncategorized";
      let productId = req.uploadProductId || "temp";

      // Get processed image URLs
      let imageUrls = [];
      if (req.processedImages && req.processedImages.length > 0) {
        imageUrls = req.processedImages;
      } else {
        // Fallback: generate URLs from uploaded files
        imageUrls = req.files.map((f) => {
          const relativePath = path.relative(uploadDir, f.path);
          return `/uploads/${relativePath.replace(/\\/g, "/")}`;
        });
      }

      res.status(200).json({
        success: true,
        message: `${imageUrls.length} image(s) uploaded successfully`,
        imageUrls: imageUrls,
        data: {
          urls: imageUrls,
          count: imageUrls.length,
          category: category,
          productId: productId,
        },
      });
    } catch (error) {
      // Delete uploaded files if error occurs
      if (req.files) {
        const filesToDelete = req.files.map((f) => f.path);
        for (const filePath of filesToDelete) {
          try {
            if (fs.existsSync(filePath)) {
              await fs.promises.unlink(filePath);
            }
          } catch (err) {
            console.error("Error deleting file:", err);
          }
        }
      }
      console.error("Error uploading images:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to upload images",
      });
    }
  },
);
// CREATE new product with initial stock tracking
router.post("/", async (req, res) => {
  try {
    const productData = req.body;

    // Validate required fields
    if (!productData.product_id) {
      return res.status(400).json({
        success: false,
        error: "Product ID is required",
      });
    }
    if (!productData.category) {
      return res.status(400).json({
        success: false,
        error: "Category is required",
      });
    }
    if (!productData.name) {
      return res.status(400).json({
        success: false,
        error: "Product name is required",
      });
    }
    if (!productData.price || productData.price <= 0) {
      return res.status(400).json({
        success: false,
        error: "Valid price is required",
      });
    }
    if (!productData.retail_price || productData.retail_price <= 0) {
      return res.status(400).json({
        success: false,
        error: "Valid retail price is required",
      });
    }

    // Default stock to 1 if not provided
    const initialStock = productData.stock || 1;

    // Check if product exists using transaction
    const result = await withTransaction(async (connection) => {
      // Check for existing product
      const [existing] = await connection.query(
        "SELECT id FROM products WHERE product_id = ?",
        [productData.product_id],
      );

      if (existing.length > 0) {
        throw new Error("Product ID already exists");
      }

      // Insert product with product_weight
      const [insertResult] = await connection.query(
        `INSERT INTO products 
         (product_id, category, name, description, price, retail_price, discount, stock, status, images, product_weight) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          productData.product_id,
          productData.category,
          productData.name,
          productData.description || "",
          productData.price,
          productData.retail_price,
          productData.discount || 0,
          initialStock,
          productData.status || "active",
          JSON.stringify(productData.images || []),
          productData.product_weight || 0, // New field
        ],
      );

      // Add initial stock transaction record
      await connection.query(
        `INSERT INTO product_stock 
         (product_id, product_name, stock, previous_stock, change_type, change_reason) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          productData.product_id,
          productData.name,
          initialStock,
          0,
          "initial",
          "Initial stock when product was created",
        ],
      );

      return insertResult.insertId;
    });

    const product = await Product.findById(result);

    // Clear cache
    searchCache.clear();

    res.status(201).json({
      success: true,
      data: product,
      message: "Product created successfully with initial stock",
    });
  } catch (error) {
    console.error("Error creating product:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to create product",
    });
  }
});
// UPDATE product
router.put("/:id", async (req, res) => {
  try {
    let product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        error: "Product not found",
      });
    }

    const updateData = req.body;

    // Handle image updates - check if images were removed
    if (updateData.images && Array.isArray(updateData.images)) {
      // Delete old images that are no longer in the list
      const oldImages = product.images || [];
      const newImages = updateData.images || [];
      const imagesToDelete = oldImages.filter(
        (img) => !newImages.includes(img),
      );

      if (imagesToDelete.length > 0) {
        await deleteMultipleFiles(imagesToDelete);
      }
    }

    // Update product
    const updated = await Product.update(req.params.id, updateData);

    // Clear cache
    searchCache.clear();

    res.json({
      success: true,
      data: updated,
      message: "Product updated successfully",
    });
  } catch (error) {
    console.error("Error updating product:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to update product",
    });
  }
});

// DELETE product
router.delete("/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        error: "Product not found",
      });
    }

    // Delete associated images using the product folder
    await deleteProductImages(product.category, product.product_id);

    await Product.delete(req.params.id);

    // Clear cache
    searchCache.clear();

    res.json({
      success: true,
      message: "Product deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting product:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE product image
router.delete("/:id/images", async (req, res) => {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        error: "Image URL is required",
      });
    }

    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        error: "Product not found",
      });
    }

    // Remove image from product
    const imageIndex = product.images.indexOf(imageUrl);
    if (imageIndex === -1) {
      return res.status(404).json({
        success: false,
        error: "Image not found in product",
      });
    }

    product.images.splice(imageIndex, 1);
    await Product.update(req.params.id, { images: product.images });

    // Delete the actual file
    await deleteMultipleFiles([imageUrl]);

    // Clear cache
    searchCache.clear();

    res.json({
      success: true,
      message: "Image deleted successfully",
      data: product,
    });
  } catch (error) {
    console.error("Error deleting image:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET product categories
router.get("/categories/all", async (req, res) => {
  try {
    const categories = await Product.getCategories();
    res.json({
      success: true,
      data: categories,
    });
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET low stock products
router.get("/low-stock/:threshold?", async (req, res) => {
  try {
    const threshold = parseInt(req.params.threshold) || 5;
    const products = await Product.getLowStock(threshold);
    res.json({
      success: true,
      data: products,
    });
  } catch (error) {
    console.error("Error fetching low stock products:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bulk update stock
router.patch("/bulk-stock", async (req, res) => {
  try {
    const { updates } = req.body;

    if (!updates || !Array.isArray(updates)) {
      return res.status(400).json({
        success: false,
        error: "Updates array is required",
      });
    }

    const results = await withTransaction(async (connection) => {
      const promises = updates.map(({ productId, quantity }) => {
        return connection.query(
          "UPDATE products SET stock = stock + ? WHERE product_id = ?",
          [quantity, productId],
        );
      });
      return Promise.all(promises);
    });

    // Clear cache
    searchCache.clear();

    res.json({
      success: true,
      message: "Stock updated successfully",
      data: results,
    });
  } catch (error) {
    console.error("Error updating bulk stock:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch("/:id/stock", async (req, res) => {
  try {
    const { stock, change_type, change_reason } = req.body;

    if (stock === undefined || stock < 0) {
      return res.status(400).json({
        success: false,
        error: "Valid stock quantity is required",
      });
    }

    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        error: "Product not found",
      });
    }

    // Update stock with tracking
    await Product.updateStockWithTracking(
      product.product_id,
      stock,
      change_type || "adjust",
      change_reason || `Stock updated from ${product.stock} to ${stock}`,
    );

    // Get updated product
    const updatedProduct = await Product.findById(req.params.id);

    // Clear cache
    searchCache.clear();

    res.json({
      success: true,
      data: updatedProduct,
      message: "Stock updated successfully",
    });
  } catch (error) {
    console.error("Error updating stock:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to update stock",
    });
  }
});

// GET stock history for a product
router.get("/:id/stock-history", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        error: "Product not found",
      });
    }

    const history = await Product.getStockHistory(product.product_id);

    res.json({
      success: true,
      data: history,
      message: "Stock history retrieved successfully",
    });
  } catch (error) {
    console.error("Error fetching stock history:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch stock history",
    });
  }
});

// GET all stock transactions (with filters)
router.get("/stock-transactions", async (req, res) => {
  try {
    const { product_id, start_date, end_date, limit = 100 } = req.query;

    let query = `
      SELECT * FROM product_stock 
      WHERE 1=1
    `;
    const params = [];

    if (product_id) {
      query += " AND product_id = ?";
      params.push(product_id);
    }

    if (start_date) {
      query += " AND created_at >= ?";
      params.push(start_date);
    }

    if (end_date) {
      query += " AND created_at <= ?";
      params.push(end_date);
    }

    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(parseInt(limit));

    const [rows] = await pool.query(query, params);

    res.json({
      success: true,
      data: rows,
      message: "Stock transactions retrieved successfully",
    });
  } catch (error) {
    console.error("Error fetching stock transactions:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch stock transactions",
    });
  }
});
module.exports = router;
