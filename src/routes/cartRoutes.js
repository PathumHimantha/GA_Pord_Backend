const express = require("express");
const router = express.Router();
const { pool, oldDbPool } = require("../config/database");
const { withTransaction, searchCache } = require("../utils/dbHelpers");

router.post("/add", async (req, res) => {
  try {
    const {
      product_id,
      customer_nic,
      quantity = 1,
      created_by = null,
    } = req.body;

    // Validate required fields
    if (!product_id) {
      return res.status(400).json({
        success: false,
        error: "Product ID is required",
      });
    }

    if (!customer_nic) {
      return res.status(400).json({
        success: false,
        error: "Customer NIC is required",
      });
    }

    // Validate NIC format (Sri Lankan)
    const oldNicPattern = /^[0-9]{9}[VX]$/i;
    const newNicPattern = /^[0-9]{12}$/;
    if (
      !oldNicPattern.test(customer_nic) &&
      !newNicPattern.test(customer_nic)
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Invalid NIC format. Please enter a valid Sri Lankan NIC (e.g., 123456789V or 123456789012)",
      });
    }

    // Check if customer is eligible to add to cart
    const eligibility = await canCustomerAddToCart(customer_nic);

    if (!eligibility.allowed) {
      return res.status(403).json({
        success: false,
        error: eligibility.reason,
        data: eligibility.status,
      });
    }

    // Check if customer already has a draft cart item
    const [existingCart] = await pool.query(
      `SELECT id, product_id, quantity, status FROM product_cart 
       WHERE customer_nic = ? AND status = 'draft'`,
      [customer_nic],
    );

    if (existingCart.length > 0) {
      return res.status(409).json({
        success: false,
        error: "Customer already has items in cart",
        data: {
          cart_items: existingCart,
          count: existingCart.length,
          customer_nic: customer_nic,
        },
      });
    }

    // Get product details
    const [product] = await pool.query(
      'SELECT product_id, name, price, stock FROM products WHERE product_id = ? AND status = "active"',
      [product_id],
    );

    if (product.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Product not found or inactive",
      });
    }

    // Check stock availability
    if (product[0].stock < quantity) {
      return res.status(400).json({
        success: false,
        error: `Insufficient stock. Available: ${product[0].stock}`,
      });
    }

    const productData = product[0];
    const totalAmount = parseFloat(productData.price) * quantity;

    // Add to cart using transaction
    const result = await withTransaction(async (connection) => {
      const [insertResult] = await connection.query(
        `INSERT INTO product_cart 
         (product_id, customer_nic, quantity, price, total_amount, status, created_by) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          product_id,
          customer_nic,
          quantity,
          productData.price,
          totalAmount,
          "draft",
          created_by || customer_nic,
        ],
      );

      return insertResult.insertId;
    });

    // Get the inserted cart item
    const [cartItem] = await pool.query(
      `SELECT pc.*, p.name as product_name, p.category, p.product_weight
       FROM product_cart pc
       JOIN products p ON pc.product_id = p.product_id
       WHERE pc.id = ?`,
      [result],
    );

    // Clear cache
    searchCache.clear();

    res.status(201).json({
      success: true,
      message: "Product added to cart successfully",
      data: {
        cart_item: cartItem[0],
        customer_status: eligibility.status,
      },
    });
  } catch (error) {
    console.error("Error adding to cart:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to add product to cart",
    });
  }
});
// Helper function to get customer status from old DB
const getCustomerStatus = async (nic) => {
  try {
    // Check if customer is LAP (due_date < today AND loan_balance > 0)
    const today = new Date().toISOString().split("T")[0];

    const [rows] = await oldDbPool.query(
      `SELECT 
        loan_code,
        customer_code,
        cname,
        nic,
        loan_amount,
        loan_balance,
        week_payment,
        loan_date,
        due_date,
        payment,
        due_amount,
        CASE 
          WHEN due_date < ? AND loan_balance > 0 THEN 'LAP'
          ELSE 'ACTIVE'
        END as customer_status
      FROM customer
      WHERE nic = ? 
      ORDER BY loan_date DESC 
      LIMIT 1`,
      [today, nic],
    );

    if (rows.length === 0) {
      return {
        exists: false,
        status: "NOT_FOUND",
        message: "Customer not found in loan system",
      };
    }

    const customer = rows[0];

    // Check if customer is LAP: due_date < today AND loan_balance > 0
    const isLap =
      customer.due_date < today && parseFloat(customer.loan_balance || 0) > 0;

    // Calculate arrears: due_amount - payment
    const payment = parseFloat(customer.payment || 0);
    const dueAmount = parseFloat(customer.due_amount || 0);
    const arrears = dueAmount - payment;
    const hasArrears = arrears > 0;

    // Check if customer has active product loan
    const [activeProductLoan] = await pool.query(
      `SELECT id, loan_code, status FROM product_loan 
       WHERE customer_nic = ? AND status IN ('approved', 'draft')`,
      [nic],
    );

    const hasActiveProductLoan = activeProductLoan.length > 0;

    return {
      exists: true,
      customer: customer,
      isLap: isLap,
      loanBalance: parseFloat(customer.loan_balance || 0),
      hasArrears: hasArrears,
      arrearsAmount: arrears,
      payment: payment,
      dueAmount: dueAmount,
      hasActiveProductLoan: hasActiveProductLoan,
      productLoanDetails: activeProductLoan[0] || null,
      status: isLap ? "LAP" : "ACTIVE",
      message: isLap
        ? `Customer is LAP (Past Due with balance of Rs. ${parseFloat(customer.loan_balance || 0).toFixed(2)})`
        : hasArrears
          ? `Customer has arrears of Rs. ${arrears.toFixed(2)}`
          : "Customer is Active",
    };
  } catch (error) {
    console.error("Error getting customer status:", error);
    return {
      exists: false,
      status: "ERROR",
      message: "Error checking customer status",
      error: error.message,
    };
  }
};

// Helper function to check if customer can add to cart
const canCustomerAddToCart = async (nic) => {
  const status = await getCustomerStatus(nic);

  if (!status.exists) {
    return {
      allowed: false,
      reason: "Customer not found in loan system",
      status: status,
    };
  }

  if (status.isLap) {
    return {
      allowed: false,
      reason: "Customer is LAP (Past Due). Cannot add to cart.",
      status: status,
    };
  }

  if (status.hasArrears) {
    return {
      allowed: false,
      reason: "Customer has arrears. Cannot add to cart.",
      status: status,
    };
  }

  if (status.hasActiveProductLoan) {
    return {
      allowed: false,
      reason: "Customer already has an active product loan.",
      status: status,
    };
  }

  return {
    allowed: true,
    reason: "Customer is eligible to add to cart",
    status: status,
  };
};

// GET - Get cart items by customer NIC
router.get("/customer/:nic", async (req, res) => {
  try {
    const { nic } = req.params;

    // Validate NIC format
    const oldNicPattern = /^[0-9]{9}[VX]$/i;
    const newNicPattern = /^[0-9]{12}$/;
    if (!oldNicPattern.test(nic) && !newNicPattern.test(nic)) {
      return res.status(400).json({
        success: false,
        error: "Invalid NIC format",
      });
    }

    const [cartItems] = await pool.query(
      `SELECT pc.*, p.name as product_name, p.category, p.images 
       FROM product_cart pc
       JOIN products p ON pc.product_id = p.product_id
       WHERE pc.customer_nic = ? AND pc.status = 'draft'
       ORDER BY pc.created_at DESC`,
      [nic],
    );

    // Parse images JSON for each item
    const items = cartItems.map((item) => {
      if (item.images) {
        try {
          item.images = JSON.parse(item.images);
        } catch (e) {
          item.images = [];
        }
      }
      return item;
    });

    res.json({
      success: true,
      data: items,
      count: items.length,
      customer_nic: nic,
    });
  } catch (error) {
    console.error("Error fetching cart items:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch cart items",
    });
  }
});

// PUT - Update cart item quantity
router.put("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;

    if (!quantity || quantity < 1) {
      return res.status(400).json({
        success: false,
        error: "Valid quantity is required",
      });
    }

    // Check if cart item exists and is draft
    const [cartItem] = await pool.query(
      'SELECT * FROM product_cart WHERE id = ? AND status = "draft"',
      [id],
    );

    if (cartItem.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Cart item not found or already processed",
      });
    }

    // Get product to check stock
    const [product] = await pool.query(
      "SELECT price, stock FROM products WHERE product_id = ?",
      [cartItem[0].product_id],
    );

    if (product.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Product not found",
      });
    }

    if (product[0].stock < quantity) {
      return res.status(400).json({
        success: false,
        error: `Insufficient stock. Available: ${product[0].stock}`,
      });
    }

    const totalAmount = parseFloat(product[0].price) * quantity;

    // Update cart item
    await pool.query(
      `UPDATE product_cart 
       SET quantity = ?, total_amount = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [quantity, totalAmount, id],
    );

    // Get updated cart item
    const [updatedItem] = await pool.query(
      `SELECT pc.*, p.name as product_name, p.category 
       FROM product_cart pc
       JOIN products p ON pc.product_id = p.product_id
       WHERE pc.id = ?`,
      [id],
    );

    res.json({
      success: true,
      message: "Cart item updated successfully",
      data: updatedItem[0],
    });
  } catch (error) {
    console.error("Error updating cart item:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to update cart item",
    });
  }
});

// DELETE - Remove cart item
router.delete("/remove/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [cartItem] = await pool.query(
      'SELECT * FROM product_cart WHERE id = ? AND status = "draft"',
      [id],
    );

    if (cartItem.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Cart item not found or already processed",
      });
    }

    await pool.query("DELETE FROM product_cart WHERE id = ?", [id]);

    res.json({
      success: true,
      message: "Cart item removed successfully",
    });
  } catch (error) {
    console.error("Error removing cart item:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to remove cart item",
    });
  }
});

// DELETE - Clear all cart items for a customer
router.delete("/clear/:nic", async (req, res) => {
  try {
    const { nic } = req.params;

    await pool.query(
      'DELETE FROM product_cart WHERE customer_nic = ? AND status = "draft"',
      [nic],
    );

    res.json({
      success: true,
      message: "Cart cleared successfully",
    });
  } catch (error) {
    console.error("Error clearing cart:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to clear cart",
    });
  }
});
// GET - Get cart items with customer details by NIC New

// GET - Get all cart items for a specific user (created_by)
router.get("/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "User ID is required",
      });
    }

    // Get all cart items for this user with status 'draft'
    const [cartItems] = await pool.query(
      `SELECT pc.*, 
              p.name as product_name, 
              p.category, 
              p.images, 
              p.product_weight,
              p.price as product_price
       FROM product_cart pc
       JOIN products p ON pc.product_id = p.product_id
       WHERE pc.created_by = ? AND pc.status = 'draft'
       ORDER BY pc.created_at DESC`,
      [userId],
    );

    // Parse images JSON for each item
    const items = cartItems.map((item) => {
      if (item.images) {
        try {
          item.images = JSON.parse(item.images);
        } catch (e) {
          item.images = [];
        }
      }
      return item;
    });

    // Get unique customer NICs to fetch customer details
    const uniqueNics = [...new Set(items.map((item) => item.customer_nic))];

    // Fetch customer details for each unique NIC
    const customerDetailsMap = new Map();
    for (const nic of uniqueNics) {
      try {
        const customerResponse = await fetch(
          `https://application.goldenasia.lk/api/api/customers/search?query=${encodeURIComponent(nic)}`,
        );
        if (customerResponse.ok) {
          const customerData = await customerResponse.json();
          customerDetailsMap.set(nic, customerData);
        }
      } catch (error) {
        console.error(`Error fetching customer details for NIC ${nic}:`, error);
      }
    }

    // Group items by customer NIC
    const groupedItems = items.reduce((acc, item) => {
      const nic = item.customer_nic;
      if (!acc[nic]) {
        acc[nic] = {
          customer_nic: nic,
          customer_details: customerDetailsMap.get(nic) || null,
          items: [],
          total_amount: 0,
          total_items: 0,
        };
      }
      acc[nic].items.push(item);
      acc[nic].total_amount += parseFloat(item.total_amount || 0);
      acc[nic].total_items += parseInt(item.quantity || 0);
      return acc;
    }, {});

    // Convert to array and sort by total amount
    const groupedArray = Object.values(groupedItems).sort(
      (a, b) => b.total_amount - a.total_amount,
    );

    // Calculate overall totals
    const overallTotal = groupedArray.reduce(
      (sum, group) => sum + group.total_amount,
      0,
    );
    const overallItems = groupedArray.reduce(
      (sum, group) => sum + group.total_items,
      0,
    );

    res.json({
      success: true,
      data: {
        groups: groupedArray,
        summary: {
          totalCustomers: groupedArray.length,
          totalItems: overallItems,
          totalAmount: overallTotal,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching user cart items:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch cart items",
    });
  }
});
module.exports = router;
