const express = require("express");
const router = express.Router();
const { pool } = require("../config/database");
const { withTransaction, searchCache } = require("../utils/dbHelpers");
const { uploadSlip } = require("../middleware/uploadSlip");

const getSlipUrl = (slipPath) => {
  if (!slipPath) return null;
  // Remove the leading 'uploads/' if present and add /uploads/
  const cleanPath = slipPath.replace(/^uploads\//, "");
  return `/uploads/payment_slips/${cleanPath}`;
};

// Helper function to update loan due dates after payment
const updateLoanDues = async (connection, loanData) => {
  try {
    const { loan_code, paymentAmount, paymentDate } = loanData;

    // Get all pending due dates for this loan
    const [dueDates] = await connection.query(
      `SELECT id, week_no, due_date, week_payment, payment, status 
       FROM loan_due_dates 
       WHERE loan_code = ? AND status = 'PENDING' 
       ORDER BY due_date ASC`,
      [loan_code],
    );

    if (dueDates.length === 0) {
      console.log(`No pending due dates found for loan: ${loan_code}`);
      return false;
    }

    // Check if there's a due date matching the payment date
    let matchedDueDate = null;
    let totalRemainingPayment = paymentAmount;

    // Find the first due date that matches or is closest to the payment date
    for (const due of dueDates) {
      const dueDateStr = due.due_date.toISOString().split("T")[0];

      // If payment date matches due date OR payment date is before next due date
      if (dueDateStr <= paymentDate) {
        matchedDueDate = due;
        break;
      }
    }

    // If no matching due date found, use the first pending due date
    if (!matchedDueDate && dueDates.length > 0) {
      matchedDueDate = dueDates[0];
    }

    if (!matchedDueDate) {
      console.log(`No suitable due date found for payment on ${paymentDate}`);
      return false;
    }

    // Calculate how much of this due date can be paid
    const remainingDue =
      parseFloat(matchedDueDate.week_payment) -
      parseFloat(matchedDueDate.payment || 0);
    const paymentToApply = Math.min(totalRemainingPayment, remainingDue);

    // Update the matched due date
    const newPayment = parseFloat(matchedDueDate.payment || 0) + paymentToApply;
    const newStatus = "PAID";

    await connection.query(
      `UPDATE loan_due_dates 
       SET payment = ?, 
           status = ?,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [newPayment, newStatus, matchedDueDate.id],
    );

    // If there's remaining payment, apply to next due dates
    let remaining = totalRemainingPayment - paymentToApply;

    if (remaining > 0) {
      // Find subsequent due dates
      const remainingDueDates = dueDates.filter(
        (d) => d.id !== matchedDueDate.id,
      );

      for (const due of remainingDueDates) {
        if (remaining <= 0) break;

        const remainingDueAmount =
          parseFloat(due.week_payment) - parseFloat(due.payment || 0);
        const paymentToApplyNext = Math.min(remaining, remainingDueAmount);

        if (paymentToApplyNext > 0) {
          const newPaymentNext =
            parseFloat(due.payment || 0) + paymentToApplyNext;
          const isFullyPaidNext =
            newPaymentNext >= parseFloat(due.week_payment);
          const newStatusNext = isFullyPaidNext ? "PAID" : "PENDING";

          await connection.query(
            `UPDATE loan_due_dates 
             SET payment = ?, 
                 status = ?,
                 updated_at = CURRENT_TIMESTAMP 
             WHERE id = ?`,
            [newPaymentNext, newStatusNext, due.id],
          );

          remaining -= paymentToApplyNext;
        }
      }
    }

    // Check if all dues are paid and update loan status if needed
    const [pendingDues] = await connection.query(
      `SELECT COUNT(*) as count FROM loan_due_dates 
       WHERE loan_code = ? AND status != 'PAID'`,
      [loan_code],
    );

    if (pendingDues[0].count === 0) {
      // All dues are paid - update loan status
      await connection.query(
        `UPDATE product_loan 
         SET order_status = 'delivered', 
             status = 'completed',
             updated_at = CURRENT_TIMESTAMP 
         WHERE loan_code = ?`,
        [loan_code],
      );

      await connection.query(
        `UPDATE product_orders 
         SET order_status = 'delivered', 
             updated_at = CURRENT_TIMESTAMP 
         WHERE loan_code = ?`,
        [loan_code],
      );
    }

    return true;
  } catch (error) {
    console.error("Error updating loan due dates:", error);
    throw error;
  }
};
// POST - Submit product payments
router.post("/submit", async (req, res) => {
  try {
    const { payments, userId } = req.body;

    if (!payments || !Array.isArray(payments) || payments.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No payments to submit",
      });
    }

    const results = await withTransaction(async (connection) => {
      const processed = [];
      const today = new Date().toISOString().split("T")[0]; // Current date for payment

      for (const payment of payments) {
        // Get current loan record with customer details
        const [loanRecord] = await connection.query(
          `SELECT pl.*, 
                  pl.customer_name, 
                  pl.customer_nic,
                  pl.center,
                  pl.ccode,
                  pl.bname,
                  pl.full_loan,
                  pl.payment as current_payment,
                  pl.loan_balance,
                  pl.due_amount,
                  pl.week_payment,
                  pl.last_payment_date
           FROM product_loan pl
           WHERE pl.loan_code = ? AND pl.status IN ('approved', 'draft')`,
          [payment.loanCode],
        );

        if (loanRecord.length === 0) {
          throw new Error(`Loan not found: ${payment.loanCode}`);
        }

        const currentLoan = loanRecord[0];
        const currentPayment = parseFloat(currentLoan.current_payment || 0);
        const currentBalance = parseFloat(currentLoan.loan_balance || 0);
        const currentDueAmount = parseFloat(currentLoan.due_amount || 0);
        const paymentAmount = parseFloat(payment.payment || 0);
        const weekPaymentAmount = parseFloat(
          payment.weekPayment || currentLoan.week_payment || 0,
        );

        // Calculate new values
        const newPayment = currentPayment + paymentAmount;
        const newBalance = Math.max(0, currentBalance - paymentAmount);
        const newDueAmount = Math.max(0, currentDueAmount - paymentAmount);

        // Get order details
        const [orderRecord] = await connection.query(
          `SELECT order_code FROM product_orders WHERE loan_code = ?`,
          [payment.loanCode],
        );

        const orderCode =
          orderRecord.length > 0 ? orderRecord[0].order_code : "";

        // 1. Insert into product_payments
        await connection.query(
          `INSERT INTO product_payments 
           (loan_code, order_code, customer_nic, customer_name, payment, week_payment, 
            payment_date, bname, center, ccode, created_by, payment_method) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            payment.loanCode,
            orderCode,
            currentLoan.customer_nic,
            currentLoan.customer_name,
            paymentAmount,
            weekPaymentAmount,
            today,
            currentLoan.bname || "",
            currentLoan.center || "",
            currentLoan.ccode || "",
            userId || payment.created_by || "system",
            payment.paymentMethod || "cash",
          ],
        );

        // 2. Update product_loan: payment, loan_balance, due_amount, last_payment_date
        await connection.query(
          `UPDATE product_loan 
           SET payment = ?, 
               loan_balance = ?, 
               due_amount = ?,
               last_payment_date = ?,
               updated_at = CURRENT_TIMESTAMP 
           WHERE loan_code = ?`,
          [newPayment, newBalance, newDueAmount, today, payment.loanCode],
        );
        await updateLoanDues(connection, {
          loan_code: payment.loanCode,
          paymentAmount: paymentAmount,
          paymentDate: today,
        });
        // 3. Update order status if loan is fully paid
        if (newBalance <= 0) {
          await connection.query(
            `UPDATE product_orders 
             SET order_status = 'delivered', updated_at = CURRENT_TIMESTAMP 
             WHERE loan_code = ?`,
            [payment.loanCode],
          );

          await connection.query(
            `UPDATE product_loan 
             SET order_status = 'delivered', updated_at = CURRENT_TIMESTAMP 
             WHERE loan_code = ?`,
            [payment.loanCode],
          );
        }

        processed.push({
          loanCode: payment.loanCode,
          orderCode: orderCode,
          amount: paymentAmount,
          newPayment,
          newBalance,
          newDueAmount,
          lastPaymentDate: today,
          isFullyPaid: newBalance <= 0,
        });
      }

      return processed;
    });

    // Clear cache
    searchCache.clear();

    res.json({
      success: true,
      message: "Payments submitted successfully",
      data: {
        count: results.length,
        results: results,
      },
    });
  } catch (error) {
    console.error("Error submitting payments:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to submit payments",
    });
  }
});

// GET - Get payment history by loan code
router.get("/history/:loanCode", async (req, res) => {
  try {
    const { loanCode } = req.params;

    const [rows] = await pool.query(
      `SELECT * FROM product_payments 
       WHERE loan_code = ? 
       ORDER BY payment_date DESC, created_at DESC`,
      [loanCode],
    );

    res.json({
      success: true,
      data: rows,
      count: rows.length,
    });
  } catch (error) {
    console.error("Error fetching payment history:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch payment history",
    });
  }
});

// GET - Get payment history by customer NIC
router.get("/customer/:nic", async (req, res) => {
  try {
    const { nic } = req.params;

    const [rows] = await pool.query(
      `SELECT * FROM product_payments 
       WHERE customer_nic = ? 
       ORDER BY payment_date DESC, created_at DESC`,
      [nic],
    );

    res.json({
      success: true,
      data: rows,
      count: rows.length,
    });
  } catch (error) {
    console.error("Error fetching customer payments:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch customer payments",
    });
  }
});

// GET - Get all payments with filters
router.get("/", async (req, res) => {
  try {
    const {
      start_date,
      end_date,
      bname,
      center,
      limit = 100,
      page = 1,
    } = req.query;

    let query = `
      SELECT * FROM product_payments 
      WHERE 1=1
    `;
    const params = [];
    const offset = (parseInt(page) - 1) * parseInt(limit);

    if (start_date) {
      query += " AND payment_date >= ?";
      params.push(start_date);
    }

    if (end_date) {
      query += " AND payment_date <= ?";
      params.push(end_date);
    }

    if (bname) {
      query += " AND bname = ?";
      params.push(bname);
    }

    if (center) {
      query += " AND center = ?";
      params.push(center);
    }

    // Get total count
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total FROM product_payments WHERE 1=1 
       ${start_date ? "AND payment_date >= ?" : ""}
       ${end_date ? "AND payment_date <= ?" : ""}
       ${bname ? "AND bname = ?" : ""}
       ${center ? "AND center = ?" : ""}`,
      params,
    );
    const total = countResult[0]?.total || 0;

    query += " ORDER BY payment_date DESC, created_at DESC LIMIT ? OFFSET ?";
    params.push(parseInt(limit), offset);

    const [rows] = await pool.query(query, params);

    res.json({
      success: true,
      data: rows,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        totalItems: total,
        itemsPerPage: parseInt(limit),
      },
    });
  } catch (error) {
    console.error("Error fetching payments:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch payments",
    });
  }
});

// GET - Get payment summary
router.get("/summary", async (req, res) => {
  try {
    const { start_date, end_date, bname, center } = req.query;

    let query = `
      SELECT 
        COUNT(*) as total_payments,
        SUM(payment) as total_amount,
        COUNT(DISTINCT customer_nic) as unique_customers,
        COUNT(DISTINCT loan_code) as unique_loans
      FROM product_payments 
      WHERE 1=1
    `;
    const params = [];

    if (start_date) {
      query += " AND payment_date >= ?";
      params.push(start_date);
    }

    if (end_date) {
      query += " AND payment_date <= ?";
      params.push(end_date);
    }

    if (bname) {
      query += " AND bname = ?";
      params.push(bname);
    }

    if (center) {
      query += " AND center = ?";
      params.push(center);
    }

    const [rows] = await pool.query(query, params);

    res.json({
      success: true,
      data: rows[0] || {
        total_payments: 0,
        total_amount: 0,
        unique_customers: 0,
        unique_loans: 0,
      },
    });
  } catch (error) {
    console.error("Error fetching payment summary:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch payment summary",
    });
  }
});

// POST - Single product payment with slip upload
router.post("/single", uploadSlip, async (req, res) => {
  try {
    const {
      loanCode,
      orderCode,
      customerNic,
      customerName,
      payment,
      weekPayment,
      paymentMethod = "cash",
      created_by,
    } = req.body;

    // Validate required fields
    if (!loanCode) {
      return res.status(400).json({
        success: false,
        error: "Loan code is required",
      });
    }
    if (!customerNic) {
      return res.status(400).json({
        success: false,
        error: "Customer NIC is required",
      });
    }
    if (!payment || payment <= 0) {
      return res.status(400).json({
        success: false,
        error: "Valid payment amount is required",
      });
    }

    // Get slip path if uploaded
    let slipPath = null;
    if (req.file) {
      // Get relative path from uploads directory
      const relativePath = req.file.path.replace(/^.*?uploads\\/, "");
      slipPath = relativePath.replace(/\\/g, "/");
    }

    const result = await withTransaction(async (connection) => {
      const today = new Date().toISOString().split("T")[0];

      // Get current loan record
      const [loanRecord] = await connection.query(
        `SELECT pl.*, 
                pl.customer_name, 
                pl.customer_nic,
                pl.center,
                pl.ccode,
                pl.bname,
                pl.full_loan,
                pl.payment as current_payment,
                pl.loan_balance,
                pl.due_amount,
                pl.week_payment,
                pl.last_payment_date
         FROM product_loan pl
         WHERE pl.loan_code = ? AND pl.status IN ('approved', 'draft')`,
        [loanCode],
      );

      if (loanRecord.length === 0) {
        throw new Error(`Loan not found: ${loanCode}`);
      }

      const currentLoan = loanRecord[0];
      const currentPayment = parseFloat(currentLoan.current_payment || 0);
      const currentBalance = parseFloat(currentLoan.loan_balance || 0);
      const currentDueAmount = parseFloat(currentLoan.due_amount || 0);
      const paymentAmount = parseFloat(payment || 0);
      const weekPaymentAmount = parseFloat(
        weekPayment || currentLoan.week_payment || 0,
      );

      // Calculate new values
      const newPayment = currentPayment + paymentAmount;
      const newBalance = Math.max(0, currentBalance - paymentAmount);
      const newDueAmount = Math.max(0, currentDueAmount - paymentAmount);

      // Get order details
      const [orderRecord] = await connection.query(
        `SELECT order_code FROM product_orders WHERE loan_code = ?`,
        [loanCode],
      );

      const orderCodeValue =
        orderRecord.length > 0 ? orderRecord[0].order_code : "";

      // 1. Insert into product_payments with slip_path
      await connection.query(
        `INSERT INTO product_payments 
         (loan_code, order_code, customer_nic, customer_name, payment, week_payment, 
          payment_date, bname, center, ccode, created_by, payment_method, slip_path) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          loanCode,
          orderCodeValue,
          customerNic,
          customerName || currentLoan.customer_name,
          paymentAmount,
          weekPaymentAmount,
          today,
          currentLoan.bname || "",
          currentLoan.center || "",
          currentLoan.ccode || "",
          created_by || "system",
          paymentMethod,
          slipPath, // Store the slip path
        ],
      );

      // 2. Update product_loan: payment, loan_balance, due_amount, last_payment_date
      await connection.query(
        `UPDATE product_loan 
         SET payment = ?, 
             loan_balance = ?, 
             due_amount = ?,
             last_payment_date = ?,
             updated_at = CURRENT_TIMESTAMP 
         WHERE loan_code = ?`,
        [newPayment, newBalance, newDueAmount, today, loanCode],
      );
      await updateLoanDues(connection, {
        loan_code: loanCode,
        paymentAmount: paymentAmount,
        paymentDate: today,
      });
      // 3. Update order status if loan is fully paid
      if (newBalance <= 0) {
        await connection.query(
          `UPDATE product_orders 
           SET order_status = 'delivered', updated_at = CURRENT_TIMESTAMP 
           WHERE loan_code = ?`,
          [loanCode],
        );

        await connection.query(
          `UPDATE product_loan 
           SET order_status = 'delivered', updated_at = CURRENT_TIMESTAMP 
           WHERE loan_code = ?`,
          [loanCode],
        );
      }

      return {
        loanCode,
        orderCode: orderCodeValue,
        amount: paymentAmount,
        newPayment,
        newBalance,
        newDueAmount,
        lastPaymentDate: today,
        isFullyPaid: newBalance <= 0,
        slipPath: slipPath ? getSlipUrl(slipPath) : null,
      };
    });

    // Clear cache
    searchCache.clear();

    res.json({
      success: true,
      message: "Payment submitted successfully",
      data: result,
    });
  } catch (error) {
    console.error("Error submitting single payment:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to submit payment",
    });
  }
});
module.exports = router;
