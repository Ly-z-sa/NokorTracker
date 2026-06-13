import dotenv from 'dotenv';
import { initDb } from './db.js';
import { bot } from './bot.js';
import { startScheduler } from './scheduler.js';

dotenv.config();

async function main() {
  console.log('🚀 Starting NokorTrackBot system...');

  // 1. Initialize SQLite Database
  try {
    initDb();
    console.log('📂 Database initialized and tables verified.');
  } catch (err) {
    console.error('❌ Failed to initialize database:', err);
    process.exit(1);
  }

  // 2. Start Cron Scheduler
  try {
    startScheduler();
  } catch (err) {
    console.error('❌ Failed to start background scheduler:', err);
    process.exit(1);
  }

  // 3. Launch Telegram Bot
  try {
    await bot.launch();
    console.log('🤖 Telegram Bot launched successfully and listening for events.');
  } catch (err) {
    console.error('❌ Failed to launch Telegram Bot:', err);
    process.exit(1);
  }

  // Graceful shutdown handling
  const shutdown = (signal) => {
    console.log(`\n🛑 Received ${signal}. Shutting down NokorTrackBot gracefully...`);
    bot.stop(signal);
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main();
