const express = require("express");
const router = express.Router();
const { pool } = require("../config/database");
const { withTransaction, searchCache } = require("../utils/dbHelpers");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, "../../uploads/purchase_agreements");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const { customer_code } = req.body;
    const loanCode = generateLoanCode(customer_code);
    const ext = path.extname(file.originalname);
    // Format: PG00_001_001_01_20260901.jpg
    const cleanLoanCode = loanCode.replace(/\//g, "_");
    cb(null, `${cleanLoanCode}${ext}`);
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/jpg",
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, JPG, and PNG files are allowed"), false);
    }
  },
});

// Helper to generate loan code with customer code
const generateLoanCode = (customerCode, date) => {
  const dateStr = date || new Date();
  const year = dateStr.getFullYear();
  const month = String(dateStr.getMonth() + 1).padStart(2, "0");
  const day = String(dateStr.getDate()).padStart(2, "0");
  const formattedDate = `${year}${month}${day}`;
  return `P${customerCode}/${formattedDate}`;
};

// Helper to generate order code
const generateOrderCode = (productId, customerCode, date) => {
  const dateStr = date || new Date();
  const year = dateStr.getFullYear();
  const month = String(dateStr.getMonth() + 1).padStart(2, "0");
  const day = String(dateStr.getDate()).padStart(2, "0");
  const formattedDate = `${year}${month}${day}`;
  const random = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  return `ORD-${productId}-${formattedDate}-${random}`;
};

// Helper function to calculate courier charge
const calculateCourierCharge = (weight) => {
  const numWeight = parseFloat(weight) || 0;
  if (numWeight <= 0) return 0;

  const firstKgRate = 560;
  const additionalKgRate = 180;
  const roundedWeight = Math.ceil(numWeight);

  if (roundedWeight <= 1) {
    return firstKgRate;
  }
  return firstKgRate + (roundedWeight - 1) * additionalKgRate;
};

// ✅ Helper to calculate document fee based on product price
const calculateDocumentFee = (totalAmount) => {
  const amount = parseFloat(totalAmount) || 0;
  // If product price >= 15000, doc fee is 1000, else 500
  return amount >= 15000 ? 1000 : 500;
};

const getDayName = (date) => {
  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  return days[date.getDay()];
};

// Helper function to calculate loan due dates
const calLoanDueDates = async (connection, loanData) => {
  try {
    const {
      loan_code,
      customer_code,
      total_amount,
      week_payment,
      period_weeks = 13,
      loan_date,
      bname,
      center,
      loan_type = "Product Loan",
    } = loanData;

    // Parse loan date
    const startDate = new Date(loan_date);

    // Generate due dates for each week
    const dueDates = [];
    for (let weekNo = 1; weekNo <= period_weeks; weekNo++) {
      const dueDate = new Date(startDate);
      dueDate.setDate(dueDate.getDate() + weekNo * 7);
      const dueDateStr = dueDate.toISOString().split("T")[0];

      dueDates.push([
        loan_code,
        customer_code,
        weekNo,
        dueDateStr,
        week_payment,
        0, // payment
        "PENDING", // status
        loan_type,
        bname || "",
        center || "",
      ]);
    }

    if (dueDates.length > 0) {
      const placeholders = dueDates
        .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .join(", ");
      const values = dueDates.flat();

      await connection.query(
        `INSERT INTO loan_due_dates 
         (loan_code, customer_code, week_no, due_date, week_payment, 
          payment, status, loan_type, bname, center) 
         VALUES ${placeholders}`,
        values,
      );
    }

    return dueDates.length;
  } catch (error) {
    console.error("Error calculating loan due dates:", error);
    throw error;
  }
};

router.post(
  "/submit",
  upload.single("purchase_agreement"),
  async (req, res) => {
    try {
      const {
        customer_nic,
        customer_name,
        customer_address,
        customer_phone,
        product_id,
        total_amount,
        quantity = 1,
        price,
        center,
        ccode,
        bname,
        customer_code,
        period_weeks = 13,
        created_by,
        product_weight = 0,
        courier_charge = 0,
        product_ids,
      } = req.body;

      // Parse product_ids if it's a string
      let productIdsArray = [];
      if (product_ids) {
        try {
          productIdsArray =
            typeof product_ids === "string"
              ? JSON.parse(product_ids)
              : product_ids;
        } catch (e) {
          productIdsArray = [parseInt(product_ids)];
        }
      }

      // Validate required fields
      if (!customer_nic || customer_nic.trim() === "") {
        return res.status(400).json({
          success: false,
          error: "Customer NIC is required",
        });
      }

      if (!customer_name || customer_name.trim() === "") {
        return res.status(400).json({
          success: false,
          error: "Customer name is required",
        });
      }

      if (!product_id) {
        return res.status(400).json({
          success: false,
          error: "Product ID is required",
        });
      }

      if (!total_amount || total_amount <= 0) {
        return res.status(400).json({
          success: false,
          error: "Valid total amount is required",
        });
      }

      if (!customer_code || customer_code.trim() === "") {
        return res.status(400).json({
          success: false,
          error: "Customer code is required",
        });
      }

      // ✅ Generate loan code first (needed for file naming)
      const loanCode = generateLoanCode(customer_code);
      const orderCode = generateOrderCode(product_id, customer_code);

      let purchaseAgreementPath = null;
      if (req.file) {
        // File is saved directly in uploads/purchase_agreements/ folder
        // Store the relative path
        purchaseAgreementPath = `/uploads/purchase_agreements/${req.file.filename}`;
      } else {
        return res.status(400).json({
          success: false,
          error: "Purchase Agreement file is required",
        });
      }

      // ✅ Calculate document fee based on product price
      const productPrice = parseFloat(total_amount);
      const documentFee = calculateDocumentFee(productPrice);

      // ✅ Use courier_charge from frontend or calculate
      const courierCharge =
        parseFloat(courier_charge) || calculateCourierCharge(product_weight);

      // ✅ Total amount = product price (no interest)
      const totalAmount = productPrice;

      // ✅ Full loan = product price (no interest)
      const fullLoanAmount = productPrice;

      // ✅ Loan balance = product price
      const loanBalance = productPrice;

      // ✅ Due amount = product price
      const dueAmount = productPrice;

      // ✅ Calculate week payment = product price / period weeks
      const weekPayment = parseFloat(
        (productPrice / parseFloat(period_weeks)).toFixed(2),
      );

      // Calculate loan_date and due_date
      const loanDate = new Date();
      const dueDate = new Date(loanDate);
      dueDate.setDate(dueDate.getDate() + parseInt(period_weeks) * 7);

      const loanDateStr = loanDate.toISOString().split("T")[0];
      const dueDateStr = dueDate.toISOString().split("T")[0];

      // Get day name for loan_day
      const loanDay = getDayName(loanDate);
      const lastPaymentDateStr = loanDateStr;

      // Start transaction
      const result = await withTransaction(async (connection) => {
        // 1. Insert into product_loan
        const [loanInsertResult] = await connection.query(
          `INSERT INTO product_loan 
           (loan_code, customer_nic, customer_name, customer_address, customer_phone, 
            product_id, total_amount, full_loan, week_payment, week_payment_original, 
            period_weeks, status, created_by, center, ccode, bname, customer_code, 
            order_status, courier_charge, document_fee, payment, loan_balance, due_amount,
            loan_date, due_date, loan_day, last_payment_date, purchase_agreement) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            loanCode,
            customer_nic,
            customer_name,
            customer_address || "",
            customer_phone || "",
            product_id,
            totalAmount, // ✅ product price
            fullLoanAmount, // ✅ product price (no interest)
            weekPayment,
            weekPayment, // ✅ same as weekPayment
            parseInt(period_weeks),
            "approved",
            created_by || "system",
            center || "",
            ccode || "",
            bname || "",
            customer_code,
            "pending",
            courierCharge,
            documentFee,
            0,
            loanBalance, // ✅ product price
            dueAmount, // ✅ product price
            loanDateStr,
            dueDateStr,
            loanDay,
            lastPaymentDateStr,
            purchaseAgreementPath,
          ],
        );

        // 2. Insert into product_orders
        const [orderInsertResult] = await connection.query(
          `INSERT INTO product_orders 
           (order_code, loan_code, product_id, customer_nic, customer_name, 
            customer_address, customer_phone, quantity, price, total_amount, 
            week_payment, period_weeks, order_status, status, created_by,
            courier_charge, product_weight,purchase_agreement) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            orderCode,
            loanCode,
            product_id,
            customer_nic,
            customer_name,
            customer_address || "",
            customer_phone || "",
            parseInt(quantity) || 1,
            productPrice,
            totalAmount,
            weekPayment,
            parseInt(period_weeks),
            "pending",
            "active",
            created_by || "system",
            courierCharge,
            parseFloat(product_weight) || 0,
            purchaseAgreementPath,
          ],
        );

        // 3. Update cart items status to 'completed'
        const [cartItems] = await connection.query(
          `SELECT id FROM product_cart 
           WHERE customer_nic = ? AND status = 'draft'`,
          [customer_nic],
        );

        if (cartItems.length > 0) {
          const cartIds = cartItems.map((item) => item.id);
          const placeholders = cartIds.map(() => "?").join(",");
          await connection.query(
            `UPDATE product_cart 
             SET status = 'completed', updated_at = CURRENT_TIMESTAMP 
             WHERE id IN (${placeholders}) AND status = 'draft'`,
            cartIds,
          );
        }

        await calLoanDueDates(connection, {
          loan_code: loanCode,
          customer_code: customer_code,
          total_amount: fullLoanAmount,
          week_payment: weekPayment,
          period_weeks: parseInt(period_weeks),
          loan_date: loanDateStr,
          bname: bname || "",
          center: center || "",
          loan_type: "Product Loan",
        });

        return {
          loanId: loanInsertResult.insertId,
          orderId: orderInsertResult.insertId,
          loanCode,
          orderCode,
          courierCharge,
          documentFee,
          totalAmount,
          fullLoanAmount,
          weekPayment,
          loanBalance,
          dueAmount,
          loanDate: loanDateStr,
          dueDate: dueDateStr,
          loanDay: loanDay,
          lastPaymentDate: lastPaymentDateStr,
          purchaseAgreementPath,
        };
      });

      // Get the inserted loan and order records
      const [loanRecord] = await pool.query(
        `SELECT * FROM product_loan WHERE id = ?`,
        [result.loanId],
      );

      const [orderRecord] = await pool.query(
        `SELECT * FROM product_orders WHERE id = ?`,
        [result.orderId],
      );

      // Clear cache
      searchCache.clear();

      res.status(201).json({
        success: true,
        message: "Product loan submitted successfully",
        data: {
          loan: loanRecord[0],
          order: orderRecord[0],
          loanCode: result.loanCode,
          orderCode: result.orderCode,
          courierCharge: result.courierCharge,
          documentFee: result.documentFee,
          totalAmount: result.totalAmount,
          fullLoanAmount: result.fullLoanAmount,
          weekPayment: result.weekPayment,
          loanBalance: result.loanBalance,
          dueAmount: result.dueAmount,
          loanDate: result.loanDate,
          dueDate: result.dueDate,
          loanDay: result.loanDay,
          lastPaymentDate: result.lastPaymentDate,
          purchaseAgreement: result.purchaseAgreementPath,
        },
      });
    } catch (error) {
      console.error("Error submitting product loan:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to submit product loan",
      });
    }
  },
);

// GET - Get all product loans
router.get("/", async (req, res) => {
  try {
    const { status, customer_nic, limit = 50 } = req.query;

    let query = `
      SELECT * FROM product_loan 
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += " AND status = ?";
      params.push(status);
    }

    if (customer_nic) {
      query += " AND customer_nic = ?";
      params.push(customer_nic);
    }

    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(parseInt(limit));

    const [rows] = await pool.query(query, params);

    const loans = rows.map((row) => {
      try {
        row.product_ids = JSON.parse(row.product_ids);
      } catch (e) {
        row.product_ids = [];
      }
      return row;
    });

    res.json({
      success: true,
      data: loans,
      count: loans.length,
    });
  } catch (error) {
    console.error("Error fetching product loans:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch product loans",
    });
  }
});

// GET - Get all product orders with filters
router.get("/orders", async (req, res) => {
  try {
    const {
      order_status,
      customer_nic,
      bname,
      center,
      limit = 50,
      page = 1,
    } = req.query;

    let query = `
      SELECT po.*, 
             pl.bname, 
             pl.center, 
             pl.ccode,
             pl.loan_balance,
             pl.due_date as loan_due_date,
             pl.loan_date,
             pl.full_loan,
             pl.payment as total_paid,
             pl.document_fee,
             pl.courier_charge
      FROM product_orders po
      JOIN product_loan pl ON po.loan_code = pl.loan_code
      WHERE 1=1
    `;
    const params = [];
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Filter by order_status
    if (order_status) {
      query += " AND po.order_status = ?";
      params.push(order_status);
    }

    // Filter by customer_nic
    if (customer_nic) {
      query += " AND po.customer_nic = ?";
      params.push(customer_nic);
    }

    // Filter by bname
    if (bname) {
      query += " AND pl.bname = ?";
      params.push(bname);
    }

    // Filter by center
    if (center) {
      query += " AND pl.center = ?";
      params.push(center);
    }

    // Exclude loans with zero balance (fully paid)
    query += " AND pl.loan_balance != 0";

    // Exclude loans created today (loan_date != today)
    const today = new Date().toISOString().split("T")[0];
    query += " AND pl.loan_date != ?";
    params.push(today);

    // Get total count
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total FROM product_orders po
       JOIN product_loan pl ON po.loan_code = pl.loan_code
       WHERE 1=1
       ${order_status ? "AND po.order_status = ?" : ""}
       ${customer_nic ? "AND po.customer_nic = ?" : ""}
       ${bname ? "AND pl.bname = ?" : ""}
       ${center ? "AND pl.center = ?" : ""}
       AND pl.loan_balance != 0
       AND pl.loan_date != ?`,
      [...params, today],
    );
    const total = countResult[0]?.total || 0;

    query += " ORDER BY po.created_at DESC LIMIT ? OFFSET ?";
    params.push(parseInt(limit), offset);

    const [rows] = await pool.query(query, params);

    res.json({
      success: true,
      data: rows,
      count: rows.length,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        totalItems: total,
        itemsPerPage: parseInt(limit),
      },
    });
  } catch (error) {
    console.error("Error fetching product orders:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch product orders",
    });
  }
});

router.get("/orders_to_manage", async (req, res) => {
  try {
    const { order_status, customer_nic, limit = 50 } = req.query;

    let query = `
      SELECT * FROM product_orders 
      WHERE 1=1
    `;
    const params = [];

    if (order_status) {
      query += " AND order_status = ?";
      params.push(order_status);
    }

    if (customer_nic) {
      query += " AND customer_nic = ?";
      params.push(customer_nic);
    }

    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(parseInt(limit));

    const [rows] = await pool.query(query, params);

    res.json({
      success: true,
      data: rows,
      count: rows.length,
    });
  } catch (error) {
    console.error("Error fetching product orders:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch product orders",
    });
  }
});
// GET - Get single order by order_code
router.get("/orders/:orderCode", async (req, res) => {
  try {
    const { orderCode } = req.params;

    const [rows] = await pool.query(
      `SELECT * FROM product_orders WHERE order_code = ?`,
      [orderCode],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Order not found",
      });
    }

    res.json({
      success: true,
      data: rows[0],
    });
  } catch (error) {
    console.error("Error fetching order:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch order",
    });
  }
});

// PUT - Update order status
router.put("/orders/:orderCode/status", async (req, res) => {
  try {
    const { orderCode } = req.params;
    const { order_status } = req.body;

    const validStatuses = [
      "pending",
      "approved",
      "processing",
      "shipped",
      "delivered",
      "cancelled",
    ];
    if (!validStatuses.includes(order_status)) {
      return res.status(400).json({
        success: false,
        error: "Invalid order status",
      });
    }

    const [result] = await pool.query(
      `UPDATE product_orders 
       SET order_status = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE order_code = ?`,
      [order_status, orderCode],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: "Order not found",
      });
    }

    // Also update product_loan order_status
    await pool.query(
      `UPDATE product_loan 
       SET order_status = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE loan_code = (SELECT loan_code FROM product_orders WHERE order_code = ?)`,
      [order_status, orderCode],
    );

    res.json({
      success: true,
      message: "Order status updated successfully",
    });
  } catch (error) {
    console.error("Error updating order status:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to update order status",
    });
  }
});

module.exports = router;
