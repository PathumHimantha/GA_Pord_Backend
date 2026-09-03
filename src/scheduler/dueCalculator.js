const { pool } = require("../config/database");
const { oldDbPool } = require("../config/database");
const { withTransaction } = require("../utils/dbHelpers");

/**
 * Calculate and create dues for product loans
 * This function should be run daily via a scheduler
 */
const getHolidayExclusionConditions = async (date) => {
  try {
    const [holidays] = await oldDbPool.query(
      `SELECT * FROM holiday WHERE date = ? AND cname != 'company'`,
      [date],
    );

    const branchHolidays = [];
    const centerHolidays = [];

    for (const holiday of holidays) {
      if (holiday.cname && holiday.cname !== "company") {
        // We'll check both branch and center columns
        // The same name could be a branch or center
        branchHolidays.push(holiday.cname);
        centerHolidays.push(holiday.cname);
      }
    }

    return {
      branchHolidays,
      centerHolidays,
    };
  } catch (error) {
    console.error("Error getting holiday exclusion conditions:", error);
    return {
      branchHolidays: [],
      centerHolidays: [],
    };
  }
};
const checkHoliday = async (date, bname = null, center = null) => {
  try {
    // First check if it's a company holiday (cname = 'company')
    const [companyHolidays] = await oldDbPool.query(
      `SELECT * FROM holiday WHERE date = ? AND cname = 'company'`,
      [date],
    );

    if (companyHolidays.length > 0) {
      return {
        isHoliday: true,
        holidayDetails: companyHolidays,
        reason: "Company holiday",
      };
    }

    // If bname is provided, check for branch-specific holidays
    if (bname) {
      const [branchHolidays] = await oldDbPool.query(
        `SELECT * FROM holiday WHERE date = ? AND cname = ?`,
        [date, bname],
      );

      if (branchHolidays.length > 0) {
        return {
          isHoliday: true,
          holidayDetails: branchHolidays,
          reason: `Branch holiday for ${bname}`,
        };
      }
    }

    // If center is provided, check for center-specific holidays
    if (center) {
      const [centerHolidays] = await oldDbPool.query(
        `SELECT * FROM holiday WHERE date = ? AND cname = ?`,
        [date, center],
      );

      if (centerHolidays.length > 0) {
        return {
          isHoliday: true,
          holidayDetails: centerHolidays,
          reason: `Center holiday for ${center}`,
        };
      }
    }

    // No holiday found
    return {
      isHoliday: false,
      holidayDetails: [],
      reason: "No holiday",
    };
  } catch (error) {
    console.error("Error checking holiday:", error);
    // In case of error, assume it's not a holiday to avoid blocking
    return {
      isHoliday: false,
      holidayDetails: [],
      reason: "Error checking holiday",
    };
  }
};
/**
 * Calculate and create dues for product loans
 * This function should be run daily via a scheduler
 */
const calculateDues = async () => {
  console.log(`[${new Date().toISOString()}] Starting due calculation...`);

  try {
    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    const dayName = getDayName(today);

    console.log(`Today: ${todayStr}, Day: ${dayName}`);

    // 👇 CHECK FOR HOLIDAYS FIRST
    const holidayCheck = await checkHoliday(todayStr);

    if (holidayCheck.isHoliday) {
      console.log(
        `[${todayStr}] HOLIDAY DETECTED: ${holidayCheck.reason}. Skipping due calculation.`,
      );
      return {
        success: true,
        message: `Skipped: ${holidayCheck.reason}`,
        processed: 0,
        skipped: true,
        reason: holidayCheck.reason,
      };
    }

    // 👇 Get holiday exclusions for branches/centers
    const exclusionConditions = await getHolidayExclusionConditions(todayStr);

    // Build the query with holiday exclusions
    let query = `
      SELECT 
        loan_code,
        customer_code,
        customer_nic,
        customer_name,
        week_payment,
        loan_balance,
        due_amount as current_due_amount,
        total_dues_count,
        bname,
        center
      FROM product_loan 
      WHERE loan_balance != 0 
        AND loan_day = ? 
        AND status IN ('approved', 'draft')
        AND order_status NOT IN ('delivered', 'cancelled')
        AND loan_date <= ?
    `;

    const queryParams = [dayName, todayStr];

    // 👇 Add branch and center exclusions
    const exclusionClauses = [];

    if (exclusionConditions.branchHolidays.length > 0) {
      const branchPlaceholders = exclusionConditions.branchHolidays
        .map(() => "?")
        .join(",");
      exclusionClauses.push(`bname NOT IN (${branchPlaceholders})`);
      queryParams.push(...exclusionConditions.branchHolidays);
    }

    if (exclusionConditions.centerHolidays.length > 0) {
      const centerPlaceholders = exclusionConditions.centerHolidays
        .map(() => "?")
        .join(",");
      exclusionClauses.push(`center NOT IN (${centerPlaceholders})`);
      queryParams.push(...exclusionConditions.centerHolidays);
    }

    if (exclusionClauses.length > 0) {
      query += ` AND ${exclusionClauses.join(" AND ")}`;
    }

    console.log(`Executing query with holiday exclusions...`);
    console.log(
      `Excluding branches: ${exclusionConditions.branchHolidays.join(", ") || "none"}`,
    );
    console.log(
      `Excluding centers: ${exclusionConditions.centerHolidays.join(", ") || "none"}`,
    );

    const [loans] = await pool.query(query, queryParams);

    console.log(
      `Found ${loans.length} loans to process for ${dayName} (after holiday exclusions)`,
    );

    if (loans.length === 0) {
      console.log("No loans to process today.");
      return { success: true, message: "No loans to process", processed: 0 };
    }

    const results = await withTransaction(async (connection) => {
      const processed = [];

      for (const loan of loans) {
        // Check if due already exists for today
        const [existingDue] = await connection.query(
          `SELECT id FROM product_loan_dues 
           WHERE loan_code = ? AND due_date = ? AND status = 'pending'`,
          [loan.loan_code, todayStr],
        );

        if (existingDue.length > 0) {
          console.log(
            `Due already exists for loan: ${loan.loan_code} on ${todayStr}`,
          );
          continue;
        }

        // Calculate new due amount
        const newDueAmount =
          parseFloat(loan.current_due_amount || 0) +
          parseFloat(loan.week_payment);
        const newTotalDuesCount = (loan.total_dues_count || 0) + 1;
        console.log(
          `Creating due for loan: ${loan.loan_code} - current due: ${loan.current_due_amount}, New Due Amount: ${newDueAmount}, Total Dues Count: ${newTotalDuesCount}`,
        );

        // 1. Insert into product_loan_dues
        await connection.query(
          `INSERT INTO product_loan_dues 
           (loan_code, customer_code, customer_nic, customer_name, 
            week_payment, due_date, due_amount, status) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            loan.loan_code,
            loan.customer_code,
            loan.customer_nic,
            loan.customer_name,
            loan.week_payment,
            todayStr,
            loan.week_payment, // Initial due amount is the week payment
            "pending",
          ],
        );

        // 2. Update product_loan: due_amount and total_dues_count
        await connection.query(
          `UPDATE product_loan 
           SET due_amount = ?, 
               total_dues_count = ?,
               updated_at = CURRENT_TIMESTAMP 
           WHERE loan_code = ?`,
          [newDueAmount, newTotalDuesCount, loan.loan_code],
        );

        processed.push({
          loan_code: loan.loan_code,
          customer_code: loan.customer_code,
          customer_name: loan.customer_name,
          week_payment: loan.week_payment,
          due_date: todayStr,
          new_due_amount: newDueAmount,
          total_dues_count: newTotalDuesCount,
        });

        console.log(
          `✅ Due created for loan: ${loan.loan_code} - Amount: ${loan.week_payment}`,
        );
      }

      return processed;
    });

    console.log(
      `[${new Date().toISOString()}] Due calculation completed. Processed ${results.length} loans.`,
    );

    return {
      success: true,
      message: `Due calculation completed successfully`,
      processed: results.length,
      loans: results,
    };
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error in due calculation:`,
      error,
    );
    return {
      success: false,
      error: error.message,
      processed: 0,
    };
  }
};

/**
 * Get day name from date
 */
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

/**
 * Run due calculation manually (for testing or manual trigger)
 */
const runManualDueCalculation = async () => {
  return await calculateDues();
};

/**
 * Get all pending dues for a loan
 */
const getLoanDues = async (loanCode) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM product_loan_dues 
       WHERE loan_code = ? 
       ORDER BY due_date DESC`,
      [loanCode],
    );
    return rows;
  } catch (error) {
    console.error("Error fetching loan dues:", error);
    return [];
  }
};

/**
 * Get all pending dues for a customer
 */
const getCustomerDues = async (customerNic) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM product_loan_dues 
       WHERE customer_nic = ? AND status = 'pending'
       ORDER BY due_date ASC`,
      [customerNic],
    );
    return rows;
  } catch (error) {
    console.error("Error fetching customer dues:", error);
    return [];
  }
};

/**
 * Mark a due as paid when payment is made
 */
const markDueAsPaid = async (loanCode, dueDate, paymentAmount) => {
  try {
    const [result] = await pool.query(
      `UPDATE product_loan_dues 
       SET status = 'paid', updated_at = CURRENT_TIMESTAMP 
       WHERE loan_code = ? AND due_date = ? AND status = 'pending'`,
      [loanCode, dueDate],
    );

    // Update the due_amount in product_loan when a due is paid
    if (result.affectedRows > 0) {
      // Decrease the due_amount by the week_payment
      await pool.query(
        `UPDATE product_loan pl
         SET pl.due_amount = pl.due_amount - pl.week_payment,
             total_dues_count = total_dues_count - 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE pl.loan_code = ?`,
        [loanCode],
      );
    }

    return result.affectedRows > 0;
  } catch (error) {
    console.error("Error marking due as paid:", error);
    return false;
  }
};

module.exports = {
  calculateDues,
  runManualDueCalculation,
  getLoanDues,
  getCustomerDues,
  markDueAsPaid,
  getDayName,
  checkHoliday,
};
