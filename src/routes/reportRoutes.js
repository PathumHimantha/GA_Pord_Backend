const express = require("express");
const router = express.Router();
const { pool } = require("../config/database");

// POST - Get repayment data from product_loan and product_loan_dues
router.post("/repayment", async (req, res) => {
  try {
    const {
      center_input,
      branch,
      selected_date,
      user_role,
      user_branch,
      user_name,
    } = req.body;

    let query = `
      SELECT 
        pl.customer_code,
        pl.customer_nic,
        pl.customer_name,
        pl.loan_code,
        pl.total_amount as loan_amount,
        pl.loan_balance,
        pl.center,
        pl.ccode,
        pl.customer_name,
        pl.week_payment,
        pl.customer_phone as phone1,
        pl.due_amount,
        pl.total_dues_count,
        pl.loan_date,
        pl.due_date as loan_due_date,
        COALESCE(SUM(pld.due_amount), 0) as total_due_amount,
        COALESCE(COUNT(pld.id), 0) as pending_dues_count,
        CASE 
          WHEN pl.loan_balance > 0 AND pl.due_date < CURDATE() THEN 
            (pl.due_amount - pl.payment)
          ELSE 
            GREATEST(0, 
              COALESCE(SUM(pld.due_amount), 0) - COALESCE(pl.payment, 0)
            )
        END as arrears
      FROM product_loan pl
      LEFT JOIN product_loan_dues pld ON pl.loan_code = pld.loan_code 
        AND pld.status = 'pending'
      WHERE (pl.center = ? OR pl.ccode = ?)
        AND pl.loan_date <= ?
        AND pl.loan_balance != 0
        AND pl.status IN ('approved', 'draft')
        AND pl.order_status NOT IN ('delivered', 'cancelled')
    `;

    let params = [center_input, center_input, selected_date];

    // Add branch condition based on user role
    if (user_role === "admin" && branch) {
      query += ` AND pl.bname = ?`;
      params.push(branch);
    } else if (user_role === "branch_manager") {
      if (branch) {
        query += ` AND pl.bname = ?`;
        params.push(branch);
      } else {
        query += ` AND pl.bname = ?`;
        params.push(user_branch);
      }
    } else if (user_role === "executive") {
      query += ` AND pl.bname = ?`;
      params.push(branch);
    }

    query += ` GROUP BY pl.loan_code, pl.customer_code, pl.customer_nic, pl.customer_name, 
               pl.total_amount, pl.loan_balance, pl.center, pl.ccode, pl.customer_name, 
               pl.week_payment, pl.customer_phone, pl.due_amount, pl.total_dues_count,
               pl.loan_date, pl.due_date, pl.payment
               ORDER BY pl.customer_code`;

    const [customers] = await pool.query(query, params);

    // Format the data to match the expected structure
    const formattedData = customers.map((row) => ({
      customer_code: row.customer_code || "",
      loan_code: row.loan_code || "",
      loan_amount: parseFloat(row.loan_amount || 0),
      loan_balance: parseFloat(row.loan_balance || 0),
      center: row.center || "",
      ccode: row.ccode || "",
      cname: row.customer_name || "",
      week_payment: parseFloat(row.week_payment || 0),
      phone1: row.phone1 || "",
      due_amount: parseFloat(row.due_amount || 0),
      total_dues_count: parseInt(row.total_dues_count || 0),
      total_due_amount: parseFloat(row.total_due_amount || 0),
      pending_dues_count: parseInt(row.pending_dues_count || 0),
      arrears: parseFloat(row.arrears || 0),
      loan_date: row.loan_date,
      loan_due_date: row.loan_due_date,
    }));

    res.json({
      success: true,
      data: formattedData,
      count: formattedData.length,
    });
  } catch (error) {
    console.error("Error fetching product repayment data:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch repayment data",
      error: error.message,
    });
  }
});

// GET - Get product loan repayment summary
router.get("/repayment-summary", async (req, res) => {
  try {
    const { branch, center } = req.query;

    let query = `
      SELECT 
        COUNT(DISTINCT pl.loan_code) as total_loans,
        COUNT(DISTINCT pl.customer_nic) as total_customers,
        SUM(pl.loan_balance) as total_balance,
        SUM(pl.due_amount) as total_due_amount,
        SUM(pl.week_payment) as total_week_payments,
        COUNT(DISTINCT pld.id) as pending_dues,
        SUM(pld.due_amount) as pending_due_amount
      FROM product_loan pl
      LEFT JOIN product_loan_dues pld ON pl.loan_code = pld.loan_code 
        AND pld.status = 'pending'
      WHERE pl.loan_balance != 0
        AND pl.status IN ('approved', 'draft')
        AND pl.order_status NOT IN ('delivered', 'cancelled')
    `;

    const params = [];

    if (branch) {
      query += ` AND pl.bname = ?`;
      params.push(branch);
    }

    if (center) {
      query += ` AND pl.center = ?`;
      params.push(center);
    }

    const [result] = await pool.query(query, params);

    res.json({
      success: true,
      data: {
        total_loans: parseInt(result[0]?.total_loans || 0),
        total_customers: parseInt(result[0]?.total_customers || 0),
        total_balance: parseFloat(result[0]?.total_balance || 0),
        total_due_amount: parseFloat(result[0]?.total_due_amount || 0),
        total_week_payments: parseFloat(result[0]?.total_week_payments || 0),
        pending_dues: parseInt(result[0]?.pending_dues || 0),
        pending_due_amount: parseFloat(result[0]?.pending_due_amount || 0),
      },
    });
  } catch (error) {
    console.error("Error fetching repayment summary:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch repayment summary",
      error: error.message,
    });
  }
});

// GET - Get overdue loans
router.get("/overdue", async (req, res) => {
  try {
    const { branch, center } = req.query;

    let query = `
      SELECT 
        pl.loan_code,
        pl.customer_code,
        pl.customer_nic,
        pl.customer_name,
        pl.center,
        pl.ccode,
        pl.week_payment,
        pl.loan_balance,
        pl.due_amount,
        pl.loan_date,
        pl.due_date as loan_due_date,
        DATEDIFF(CURDATE(), pl.due_date) as days_overdue,
        COUNT(pld.id) as pending_dues_count,
        SUM(pld.due_amount) as pending_due_amount
      FROM product_loan pl
      LEFT JOIN product_loan_dues pld ON pl.loan_code = pld.loan_code 
        AND pld.status = 'pending'
      WHERE pl.loan_balance != 0
        AND pl.due_date < CURDATE()
        AND pl.status IN ('approved', 'draft')
        AND pl.order_status NOT IN ('delivered', 'cancelled')
    `;

    const params = [];

    if (branch) {
      query += ` AND pl.bname = ?`;
      params.push(branch);
    }

    if (center) {
      query += ` AND pl.center = ?`;
      params.push(center);
    }

    query += ` GROUP BY pl.loan_code ORDER BY days_overdue DESC`;

    const [results] = await pool.query(query, params);

    const formattedResults = results.map((row) => ({
      ...row,
      days_overdue: parseInt(row.days_overdue || 0),
      pending_dues_count: parseInt(row.pending_dues_count || 0),
      pending_due_amount: parseFloat(row.pending_due_amount || 0),
      loan_balance: parseFloat(row.loan_balance || 0),
      due_amount: parseFloat(row.due_amount || 0),
      week_payment: parseFloat(row.week_payment || 0),
    }));

    res.json({
      success: true,
      data: formattedResults,
      count: formattedResults.length,
    });
  } catch (error) {
    console.error("Error fetching overdue loans:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch overdue loans",
      error: error.message,
    });
  }
});

router.get("/product-day-end", async (req, res) => {
  try {
    const { date, bname, execName, execID } = req.query;

    if (!date || !bname || !execID) {
      return res.status(400).json({
        success: false,
        error: "Date, branch name, and executive ID are required",
      });
    }

    // Get all centers for this branch with product loans
    const [centers] = await pool.query(
      `SELECT DISTINCT pl.center, pl.ccode 
       FROM product_loan pl
       WHERE pl.bname = ? 
         AND pl.loan_date <= ?
         AND pl.loan_balance != 0
       ORDER BY pl.ccode`,
      [bname, date],
    );

    const rows = [];

    for (const center of centers) {
      // Get product loans for this center
      const [loans] = await pool.query(
        `SELECT 
          pl.loan_code,
          pl.customer_code,
          pl.customer_nic,
          pl.customer_name,
          pl.total_amount,
          pl.loan_balance,
          pl.week_payment,
          pl.due_amount,
          pl.document_fee,
          pl.courier_charge,
          pl.payment,
          pl.loan_date,
          pl.due_date as loan_due_date,
          pl.center,
          pl.ccode,
          pl.bname,
          pl.created_by,
          COALESCE(SUM(pld.due_amount), 0) as pending_due_amount,
          COUNT(DISTINCT pld.id) as pending_dues_count
        FROM product_loan pl
        LEFT JOIN product_loan_dues pld ON pl.loan_code = pld.loan_code 
          AND pld.status = 'pending'
        WHERE pl.center = ? 
          AND pl.bname = ?
          AND pl.loan_date = ?
          AND pl.loan_balance != 0
          AND pl.status IN ('approved', 'draft')
          AND pl.created_by = ?
        GROUP BY pl.loan_code`,
        [center.center, bname, date, execID],
      );

      // Get payments for this center on this date - REMOVED GROUP BY
      const [payments] = await pool.query(
        `SELECT 
          pp.loan_code,
          pp.payment,
          pp.payment_method,
          pp.payment_date,
          pp.id as payment_id
        FROM product_payments pp
        JOIN product_loan pl ON pp.loan_code = pl.loan_code
        WHERE pl.center = ? 
          AND pl.bname = ?
          AND pp.payment_date = ?
          AND pp.created_by = ?
        ORDER BY pp.id`,
        [center.center, bname, date, execID],
      );

      // Calculate totals
      let totalLoanAmount = 0;
      let totalBalance = 0;
      let totalWeekPayment = 0;
      let totalDocumentFee = 0;
      let totalCourierCharge = 0;
      let totalPayment = 0;
      let cashPayment = 0;
      let cdkPayment = 0;
      let onlinePayment = 0;
      let bankDepositPayment = 0;
      let totalPendingDues = 0;
      let pendingDuesCount = 0;

      loans.forEach((loan) => {
        totalLoanAmount += parseFloat(loan.total_amount || 0);
        totalBalance += parseFloat(loan.loan_balance || 0);
        totalWeekPayment += parseFloat(loan.week_payment || 0);
        totalDocumentFee += parseFloat(loan.document_fee || 0);
        totalCourierCharge += parseFloat(loan.courier_charge || 0);
        totalPendingDues += parseFloat(loan.pending_due_amount || 0);
        pendingDuesCount += parseInt(loan.pending_dues_count || 0);
      });

      payments.forEach((payment) => {
        const amount = parseFloat(payment.payment || 0);
        totalPayment += amount;

        const method = (payment.payment_method || "").toLowerCase();
        if (method === "cash") {
          cashPayment += amount;
        } else if (method === "cdk") {
          cdkPayment += amount;
        } else if (method === "online payment") {
          onlinePayment += amount;
        } else if (method === "bank deposit") {
          bankDepositPayment += amount;
        }
      });

      const totalDepositPayment =
        cdkPayment + onlinePayment + bankDepositPayment;

      rows.push({
        ccode: center.ccode,
        center: center.center,
        active: loans.length,
        total_loan_amount: totalLoanAmount,
        total_balance: totalBalance,
        total_week_payment: totalWeekPayment,
        document_fee: totalDocumentFee,
        courier_charge: totalCourierCharge,
        payment: totalPayment,
        cash_payment: cashPayment,
        cdk_payment: cdkPayment,
        online_payment: onlinePayment,
        bank_deposit: bankDepositPayment,
        deposit_payment: totalDepositPayment,
        pending_due_amount: totalPendingDues,
        pending_dues_count: pendingDuesCount,
        loan_count: loans.length,
        payment_count: payments.length,
        loans: loans,
        payments: payments,
      });
    }

    // Calculate totals
    const totals = rows.reduce(
      (acc, r) => ({
        active: acc.active + r.active,
        total_loan_amount: acc.total_loan_amount + r.total_loan_amount,
        total_balance: acc.total_balance + r.total_balance,
        total_week_payment: acc.total_week_payment + r.total_week_payment,
        document_fee: acc.document_fee + r.document_fee,
        courier_charge: acc.courier_charge + r.courier_charge,
        payment: acc.payment + r.payment,
        cash_payment: acc.cash_payment + r.cash_payment,
        deposit_payment: acc.deposit_payment + r.deposit_payment,
        pending_due_amount: acc.pending_due_amount + r.pending_due_amount,
        pending_dues_count: acc.pending_dues_count + r.pending_dues_count,
        loan_count: acc.loan_count + r.loan_count,
        payment_count: acc.payment_count + r.payment_count,
      }),
      {
        active: 0,
        total_loan_amount: 0,
        total_balance: 0,
        total_week_payment: 0,
        document_fee: 0,
        courier_charge: 0,
        payment: 0,
        cash_payment: 0,
        deposit_payment: 0,
        pending_due_amount: 0,
        pending_dues_count: 0,
        loan_count: 0,
        payment_count: 0,
      },
    );

    res.json({
      success: true,
      data: {
        rows: rows,
        totals: totals,
        bname: bname,
        execName: execName,
        execID: execID,
        date: date,
      },
    });
  } catch (error) {
    console.error("Error fetching product day end report:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch product day end report",
    });
  }
});

module.exports = router;
