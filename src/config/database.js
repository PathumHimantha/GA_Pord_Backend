const mysql = require("mysql2");

// New Database (Products DB)
const pool = mysql.createPool({
  host: process.env.DB_HOST || "194.163.182.128",
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "products_user",
  password: process.env.DB_PASSWORD || "Golden@123@99",
  database: process.env.DB_NAME || "products",
  waitForConnections: process.env.DB_WAIT_FOR_CONNECTIONS === "true",
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 10,
  queueLimit: parseInt(process.env.DB_QUEUE_LIMIT) || 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  namedPlaceholders: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
});

// Old Database (Loan/CRM DB)
const oldDbPool = mysql.createPool({
  host: process.env.OLD_DB_HOST || "57.128.195.112",
  port: parseInt(process.env.OLD_DB_PORT) || 3306,
  user: process.env.OLD_DB_USER || "micro_user",
  password: process.env.OLD_DB_PASSWORD || "Golden@12",
  database: process.env.OLD_DB_NAME || "micro",
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

// Promisify pools
const promisePool = pool.promise();
const oldDbPromisePool = oldDbPool.promise();

// Test connections
const connectDB = async () => {
  try {
    // Connect to new DB
    const connection = await promisePool.getConnection();
    console.log("MySQL (Products DB) Connected successfully");
    connection.release();

    // Connect to old DB
    try {
      const oldConnection = await oldDbPromisePool.getConnection();
      console.log("MySQL (Old Loan DB) Connected successfully");
      oldConnection.release();
    } catch (oldError) {
      console.warn("Warning: Old Loan DB connection failed:", oldError.message);
      // Continue even if old DB fails - we'll handle it in the functions
    }

    // Initialize tables
    await initializeTables();

    return promisePool;
  } catch (error) {
    console.error(`MySQL Connection Error: ${error.message}`);
    setTimeout(connectDB, 5000);
  }
};

// Initialize database tables
const initializeTables = async () => {
  try {
    await promisePool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id VARCHAR(50) UNIQUE NOT NULL,
        category VARCHAR(100) NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        retail_price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        discount DECIMAL(5, 2) DEFAULT 0.00,
        stock INT DEFAULT 0,
        status ENUM('active', 'inactive') DEFAULT 'active',
        images JSON DEFAULT NULL,
        product_weight DECIMAL(10, 2) DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_product_id (product_id),
        INDEX idx_category (category),
        INDEX idx_status (status),
        FULLTEXT idx_name_description (name, description)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Create product_cart table if not exists
    await promisePool.query(`
      CREATE TABLE IF NOT EXISTS product_cart (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id VARCHAR(50) NOT NULL,
        customer_nic VARCHAR(20) NOT NULL,
        quantity INT DEFAULT 1,
        price DECIMAL(10, 2) NOT NULL,
        total_amount DECIMAL(10, 2) NOT NULL,
        status ENUM('draft', 'pending', 'completed', 'cancelled') DEFAULT 'draft',
        created_by VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_product_id (product_id),
        INDEX idx_customer_nic (customer_nic),
        INDEX idx_status (status),
        FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Create product_loan table
    await promisePool.query(`
      CREATE TABLE IF NOT EXISTS product_loan (
        id INT AUTO_INCREMENT PRIMARY KEY,
        loan_code VARCHAR(50) UNIQUE NOT NULL,
        customer_nic VARCHAR(20) NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        customer_address TEXT,
        customer_phone VARCHAR(20),
        product_ids JSON,
        product_id VARCHAR(50),
        total_amount DECIMAL(10, 2) NOT NULL,
        interest_rate DECIMAL(5, 2) DEFAULT 0.00,
        total_with_interest DECIMAL(10, 2) NOT NULL,
        week_payment DECIMAL(10, 2) NOT NULL,
        week_payment_original DECIMAL(10, 2),
        period_weeks INT DEFAULT 13,
        status ENUM('draft', 'approved', 'completed', 'cancelled') DEFAULT 'draft',
        order_status ENUM('pending', 'approved', 'processing', 'shipped', 'delivered', 'cancelled') DEFAULT 'pending',
        created_by VARCHAR(50),
        center VARCHAR(50),
        ccode VARCHAR(20),
        bname VARCHAR(100),
        customer_code VARCHAR(50),
        courier_charge DECIMAL(10, 2) DEFAULT 0.00,
        document_fee DECIMAL(10, 2) DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_customer_nic (customer_nic),
        INDEX idx_loan_code (loan_code),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Create product_orders table
    await promisePool.query(`
      CREATE TABLE IF NOT EXISTS product_orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_code VARCHAR(50) UNIQUE NOT NULL,
        loan_code VARCHAR(50) NOT NULL,
        product_id VARCHAR(50) NOT NULL,
        customer_nic VARCHAR(20) NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        customer_address TEXT,
        customer_phone VARCHAR(20),
        quantity INT DEFAULT 1,
        price DECIMAL(10, 2) NOT NULL,
        total_amount DECIMAL(10, 2) NOT NULL,
        week_payment DECIMAL(10, 2) NOT NULL,
        period_weeks INT DEFAULT 13,
        order_status ENUM('pending', 'approved', 'processing', 'shipped', 'delivered', 'cancelled') DEFAULT 'pending',
        status ENUM('active', 'inactive') DEFAULT 'active',
        created_by VARCHAR(50),
        courier_charge DECIMAL(10, 2) DEFAULT 0.00,
        product_weight DECIMAL(10, 2) DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_loan_code (loan_code),
        INDEX idx_product_id (product_id),
        INDEX idx_customer_nic (customer_nic),
        INDEX idx_order_status (order_status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log("Database tables initialized successfully");
  } catch (error) {
    console.error("Error initializing tables:", error.message);
  }
};

module.exports = {
  pool: promisePool,
  oldDbPool: oldDbPromisePool,
  connectDB,
  getConnection: () => promisePool.getConnection(),
  getOldConnection: () => oldDbPromisePool.getConnection(),
};
