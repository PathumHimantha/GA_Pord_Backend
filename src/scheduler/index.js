const cron = require("node-cron");
const { calculateDues } = require("./dueCalculator");

// Initialize scheduler
const initScheduler = () => {
  console.log("[Scheduler] Initializing scheduler...");

  // Run every day at 10:00 AM
  // Cron pattern: minute hour day month dayOfWeek
  // 0 10 * * * = At 10:00 AM every day
  const job = cron.schedule(
    "0 8 * * *",
    async () => {
      console.log(
        `[Scheduler] Running due calculation at ${new Date().toISOString()}`,
      );

      try {
        const result = await calculateDues();

        if (result.success) {
          console.log(
            `[Scheduler] ✅ Due calculation completed. Processed ${result.processed} loans.`,
          );
        } else {
          console.error(
            `[Scheduler] ❌ Due calculation failed: ${result.error}`,
          );
        }
      } catch (error) {
        console.error(
          "[Scheduler] ❌ Unexpected error in scheduled job:",
          error,
        );
      }
    },
    {
      scheduled: true,
      timezone: "Asia/Colombo", // Sri Lanka timezone
    },
  );

  // Start the job
  job.start();
  console.log(
    "[Scheduler] ✅ Scheduler started. Will run daily at 10:00 AM (Asia/Colombo time)",
  );

  // Return the job instance for potential manual control
  return job;
};

// Manual trigger function
const runManualCalculation = async () => {
  console.log(
    `[Scheduler] Manual due calculation triggered at ${new Date().toISOString()}`,
  );
  return await calculateDues();
};

// Get next scheduled run time
const getNextRunTime = () => {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(10, 0, 0, 0);

  if (nextRun <= now) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  return nextRun;
};

module.exports = {
  initScheduler,
  runManualCalculation,
  getNextRunTime,
};
