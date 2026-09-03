const { pool } = require("../config/database");

class Product {
  // Create new product
  static async create(productData) {
    const {
      product_id,
      category,
      name,
      description = "",
      price,
      retail_price,
      discount = 0,
      stock = 0,
      status = "active",
      images = [],
      product_weight = 0,
    } = productData;

    const [result] = await pool.query(
      `INSERT INTO products 
     (product_id, category, name, description, price, retail_price, discount, stock, status, images, product_weight) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        product_id,
        category,
        name,
        description,
        price,
        retail_price,
        discount,
        stock,
        status,
        JSON.stringify(images),
        product_weight,
      ],
    );

    return this.findById(result.insertId);
  }

  // Find product by ID
  static async findById(id) {
    const [rows] = await pool.query(
      'SELECT *, JSON_UNQUOTE(JSON_EXTRACT(images, "$")) as images FROM products WHERE id = ?',
      [id],
    );

    if (rows.length === 0) return null;

    // Parse images JSON
    const product = rows[0];
    product.images = product.images ? JSON.parse(product.images) : [];
    return product;
  }

  // Find product by product_id
  static async findByProductId(productId) {
    const [rows] = await pool.query(
      'SELECT *, JSON_UNQUOTE(JSON_EXTRACT(images, "$")) as images FROM products WHERE product_id = ?',
      [productId],
    );

    if (rows.length === 0) return null;

    const product = rows[0];
    product.images = product.images ? JSON.parse(product.images) : [];
    return product;
  }

  // Get all products with pagination and filters
  static async findAll(options = {}) {
    const {
      page = 1,
      limit = 10,
      search = "",
      category = "",
      status = "",
      minPrice = null,
      maxPrice = null,
      sortBy = "created_at",
      sortOrder = "DESC",
    } = options;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    let conditions = [];
    let params = [];

    // Build where conditions
    if (search) {
      conditions.push(
        "(MATCH(name, description) AGAINST(?) OR product_id LIKE ? OR name LIKE ?)",
      );
      params.push(search, `%${search}%`, `%${search}%`);
    }

    if (category) {
      conditions.push("category = ?");
      params.push(category);
    }

    if (status) {
      conditions.push("status = ?");
      params.push(status);
    }

    if (minPrice !== null) {
      conditions.push("price >= ?");
      params.push(parseFloat(minPrice));
    }

    if (maxPrice !== null) {
      conditions.push("price <= ?");
      params.push(parseFloat(maxPrice));
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get total count
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total FROM products ${whereClause}`,
      params,
    );
    const total = countResult[0].total;

    // Get paginated results
    const [rows] = await pool.query(
      `SELECT *, JSON_UNQUOTE(JSON_EXTRACT(images, "$")) as images 
       FROM products 
       ${whereClause}
       ORDER BY ${sortBy} ${sortOrder}
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)],
    );

    // Parse images JSON for each row
    const products = rows.map((row) => {
      row.images = row.images ? JSON.parse(row.images) : [];
      return row;
    });

    return {
      data: products,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        totalItems: total,
        itemsPerPage: parseInt(limit),
      },
    };
  }

  // Update product
  static async update(id, updateData) {
    const fields = [];
    const values = [];

    // Build update query dynamically
    const allowedFields = [
      "category",
      "name",
      "description",
      "price",
      "retail_price",
      "discount",
      "stock",
      "status",
      "product_weight",
    ];

    for (const [key, value] of Object.entries(updateData)) {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    // Handle images separately
    if (updateData.images) {
      fields.push("images = ?");
      values.push(JSON.stringify(updateData.images));
    }

    if (fields.length === 0) {
      throw new Error("No valid fields to update");
    }

    values.push(id);

    await pool.query(
      `UPDATE products SET ${fields.join(", ")} WHERE id = ?`,
      values,
    );

    return this.findById(id);
  }

  // Delete product
  static async delete(id) {
    const [result] = await pool.query("DELETE FROM products WHERE id = ?", [
      id,
    ]);
    return result.affectedRows > 0;
  }

  // Get all distinct categories
  static async getCategories() {
    const [rows] = await pool.query(
      'SELECT DISTINCT category FROM products WHERE status = "active" ORDER BY category',
    );
    return rows.map((row) => row.category);
  }

  // Bulk update stock
  static async updateStock(productId, quantity) {
    const [result] = await pool.query(
      "UPDATE products SET stock = stock + ? WHERE product_id = ?",
      [quantity, productId],
    );
    return result.affectedRows > 0;
  }

  // Get products with low stock
  static async getLowStock(threshold = 5) {
    const [rows] = await pool.query(
      'SELECT *, JSON_UNQUOTE(JSON_EXTRACT(images, "$")) as images FROM products WHERE stock <= ? AND status = "active"',
      [threshold],
    );

    return rows.map((row) => {
      row.images = row.images ? JSON.parse(row.images) : [];
      return row;
    });
  }

  // Add stock transaction record
  static async addStockTransaction(
    productId,
    productName,
    quantity,
    changeType = "initial",
    reason = null,
  ) {
    // First get current stock from products table
    const [currentStock] = await pool.query(
      "SELECT stock FROM products WHERE product_id = ?",
      [productId],
    );

    const currentStockValue =
      currentStock.length > 0 ? currentStock[0].stock : 0;

    const [result] = await pool.query(
      `INSERT INTO product_stock 
     (product_id, product_name, stock, previous_stock, change_type, change_reason) 
     VALUES (?, ?, ?, ?, ?, ?)`,
      [productId, productName, quantity, currentStockValue, changeType, reason],
    );

    return result.insertId;
  }

  // Get stock history for a product
  static async getStockHistory(productId, limit = 50) {
    const [rows] = await pool.query(
      `SELECT * FROM product_stock 
     WHERE product_id = ? 
     ORDER BY created_at DESC 
     LIMIT ?`,
      [productId, limit],
    );
    return rows;
  }

  // Get current stock for a product
  static async getCurrentStock(productId) {
    const [rows] = await pool.query(
      "SELECT stock FROM products WHERE product_id = ?",
      [productId],
    );
    return rows.length > 0 ? rows[0].stock : 0;
  }

  // Update stock with transaction tracking
  static async updateStockWithTracking(
    productId,
    newStock,
    changeType = "adjust",
    reason = null,
  ) {
    const [product] = await pool.query(
      "SELECT name, stock FROM products WHERE product_id = ?",
      [productId],
    );

    if (product.length === 0) {
      throw new Error("Product not found");
    }

    const previousStock = product[0].stock;

    // Start transaction
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // Update product stock
      await connection.query(
        "UPDATE products SET stock = ? WHERE product_id = ?",
        [newStock, productId],
      );

      // Add stock transaction record
      await connection.query(
        `INSERT INTO product_stock 
       (product_id, product_name, stock, previous_stock, change_type, change_reason) 
       VALUES (?, ?, ?, ?, ?, ?)`,
        [
          productId,
          product[0].name,
          newStock,
          previousStock,
          changeType,
          reason,
        ],
      );

      await connection.commit();
      connection.release();

      return true;
    } catch (error) {
      await connection.rollback();
      connection.release();
      throw error;
    }
  }
}

module.exports = Product;
