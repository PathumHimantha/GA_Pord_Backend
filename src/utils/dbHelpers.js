const { pool } = require("../config/database");

// Execute query with retry logic
const executeWithRetry = async (query, params, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const [rows] = await pool.query(query, params);
      return rows;
    } catch (error) {
      if (i === retries - 1) throw error;
      // Wait before retrying (exponential backoff)
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, i)),
      );
    }
  }
};

// Transaction helper
const withTransaction = async (callback) => {
  const connection = await pool.getConnection();
  await connection.beginTransaction();

  try {
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

// Batch insert helper
const batchInsert = async (table, data, batchSize = 1000) => {
  if (!data || data.length === 0) return [];

  const results = [];
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    const placeholders = batch.map(() => "?").join(",");
    const values = batch.flat();

    const [result] = await pool.query(
      `INSERT INTO ${table} VALUES ${placeholders}`,
      values,
    );
    results.push(result);
  }
  return results;
};

// Optimized search with caching
class SearchCache {
  constructor() {
    this.cache = new Map();
    this.ttl = 5 * 60 * 1000; // 5 minutes
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }

  set(key, value) {
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  clear() {
    this.cache.clear();
  }
}

const searchCache = new SearchCache();

module.exports = {
  executeWithRetry,
  withTransaction,
  batchInsert,
  searchCache,
};
