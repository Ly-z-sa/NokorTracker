import cron from 'node-cron';
import { DateTime } from 'luxon';
import { bot, DAYS } from './bot.js';
import { getAllUsers, getSubjectsForDay, getWeeklyAttendance, getSubjects } from './db.js';
import { Markup } from 'telegraf';

// Track which alerts have already been sent this minute to avoid duplicates
// Key format: "userId:type:dateTime" e.g. "123456:reminder:2026-06-22T07:00"
const sentAlerts = new Set();

// Clear the sentAlerts set every hour to prevent unbounded memory growth
cron.schedule('0 * * * *', () => {
  sentAlerts.clear();
  console.log('[Scheduler] Cleared sent-alerts cache.');
});

/**
 * Builds a deduplication key for a scheduled alert.
 */
function alertKey(userId, type, dateTimeMinute) {
  return `${userId}:${type}:${dateTimeMinute}`;
}

/**
 * Sends a Telegram message via the raw bot.telegram API with an optional
 * inline keyboard. The Markup helper returns { reply_markup: {...} }, so
 * we must extract reply_markup explicitly for the raw sendMessage call.
 */
async function safeSend(telegramId, text, keyboardMarkup = null, label = '') {
  // Use MarkdownV2 — our messages escape special chars with the v2 ruleset
  const opts = { parse_mode: 'MarkdownV2' };
  if (keyboardMarkup) {
    // Markup.inlineKeyboard() returns an object shaped { reply_markup: {...} }
    opts.reply_markup = keyboardMarkup.reply_markup;
  }
  try {
    await bot.telegram.sendMessage(telegramId, text, opts);
    if (label) console.log(`[Scheduler] ✅ Sent "${label}" to ${telegramId}`);
  } catch (err) {
    console.error(`[Scheduler] ❌ Failed to send "${label}" to ${telegramId}:`, err.message);
  }
}

/**
 * Starts the background scheduler that monitors class times,
 * sends daily reminders, class start marking alerts, and weekly summaries.
 */
export function startScheduler() {
  console.log('⏰ Scheduler service initialized...');

  // Tick every minute
  cron.schedule('* * * * *', async () => {
    try {
      const users = getAllUsers();
      console.log(`[Scheduler] Tick — checking ${users.length} user(s)...`);

      for (const user of users) {
        const timezone = user.timezone || 'Asia/Phnom_Penh';
        const localNow = DateTime.now().setZone(timezone);
        const currentTimeStr = localNow.toFormat('HH:mm');
        const currentDateStr = localNow.toFormat('yyyy-MM-dd');
        const currentMinuteKey = localNow.toFormat("yyyy-MM-dd'T'HH:mm");

        // Check if user has defined semester dates
        if (!user.semester_start || !user.semester_end) {
          console.log(`[Scheduler] User ${user.telegram_id} has no semester configured — skipping.`);
          continue;
        }

        // Check if today is within the semester
        const semesterStart = DateTime.fromISO(user.semester_start, { zone: timezone }).startOf('day');
        const semesterEnd = DateTime.fromISO(user.semester_end, { zone: timezone }).endOf('day');
        const isSemesterActive = localNow >= semesterStart && localNow <= semesterEnd;

        if (!isSemesterActive) {
          console.log(`[Scheduler] User ${user.telegram_id} — semester not active (${user.semester_start} to ${user.semester_end}), now=${currentDateStr}.`);
          continue;
        }

        const dayOfWeek = localNow.weekday; // Luxon: .weekday is 1=Mon…7=Sun (same as .dayOfWeek)
        console.log(`[Scheduler] User ${user.telegram_id} — ${currentDateStr} ${currentTimeStr} (${DAYS[dayOfWeek] ?? `day#${dayOfWeek}`}, tz=${timezone})`);

        // ----------------------------------------------------
        // 1. MORNING CLASS REMINDER
        // ----------------------------------------------------
        const reminderKey = alertKey(user.telegram_id, 'reminder', currentMinuteKey);
        if (currentTimeStr === user.reminder_time && !sentAlerts.has(reminderKey)) {
          const todaysSubjects = getSubjectsForDay(user.telegram_id, dayOfWeek);
          console.log(`[Scheduler] Reminder time match for user ${user.telegram_id}. Classes today: ${todaysSubjects.length}`);
          if (todaysSubjects.length > 0) {
            let msg = `⏰ *Morning Class Reminder\!* 📚\n\n`;
            msg += `Today \(${currentDateStr}, ${DAYS[dayOfWeek]}\) you have the following classes:\n\n`;
            todaysSubjects.forEach((s) => {
              const sNameEscaped = s.name.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
              msg += `• *${sNameEscaped}*: ${s.start_time} \- ${s.end_time}\n`;
            });
            msg += `\nHave a great day in class\! 🚀`;

            await safeSend(user.telegram_id, msg, null, 'morning reminder');
            sentAlerts.add(reminderKey);
          }
        }

        // ----------------------------------------------------
        // 2. CLASS START ATTENDANCE ALERT
        // ----------------------------------------------------
        const allSubjects = getSubjects(user.telegram_id);
        for (const subject of allSubjects) {
          if (subject.day_of_week === dayOfWeek && subject.start_time === currentTimeStr) {
            const classKey = alertKey(user.telegram_id, `class:${subject.id}`, currentMinuteKey);
            if (sentAlerts.has(classKey)) continue;

            console.log(`[Scheduler] Class start alert for user ${user.telegram_id}, subject "${subject.name}" at ${currentTimeStr}`);

            const subNameEscaped = subject.name.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
            let msg = `🔔 *Class Session Started\!* 🏫\n\n`;
            msg += `📚 Subject: *${subNameEscaped}*\n`;
            msg += `⏰ Time: ${subject.start_time} \- ${subject.end_time}\n`;
            msg += `📅 Date: ${currentDateStr}\n\n`;
            msg += `Please mark your attendance below:`;

            const keyboard = Markup.inlineKeyboard([
              [
                Markup.button.callback('✅ Present', `mark:${subject.id}:${currentDateStr}:present`),
                Markup.button.callback('❌ Absent', `mark:${subject.id}:${currentDateStr}:absent`)
              ],
              [
                Markup.button.callback('🕒 Late', `mark:${subject.id}:${currentDateStr}:late`),
                Markup.button.callback('📝 Permission', `mark:${subject.id}:${currentDateStr}:permission`)
              ]
            ]);

            await safeSend(user.telegram_id, msg, keyboard, `class alert "${subject.name}"`);
            sentAlerts.add(classKey);
          }
        }

        // ----------------------------------------------------
        // 3. WEEKLY ATTENDANCE SUMMARY
        // ----------------------------------------------------
        // Runs on Sunday at 20:00 (8:00 PM) local time
        const weeklySummaryKey = alertKey(user.telegram_id, 'weekly', currentMinuteKey);
        if (dayOfWeek === 7 && currentTimeStr === '20:00' && !sentAlerts.has(weeklySummaryKey)) {
          const startOfWeek = localNow.startOf('week'); // Monday
          const endOfWeek = localNow.endOf('week'); // Sunday
          const startOfWeekStr = startOfWeek.toFormat('yyyy-MM-dd');
          const endOfWeekStr = endOfWeek.toFormat('yyyy-MM-dd');

          const weeklyRecords = getWeeklyAttendance(user.telegram_id, startOfWeekStr, endOfWeekStr);
          const subjects = getSubjects(user.telegram_id);

          if (subjects.length > 0) {
            let msg = `📊 *Weekly Attendance Summary* 🎓\n`;
            msg += `Period: \`${startOfWeekStr}\` to \`${endOfWeekStr}\`\n\n`;

            let hasRecords = false;

            subjects.forEach((sub) => {
              const subRecords = weeklyRecords.filter((r) => r.subject_id === sub.id);
              
              const present = subRecords.filter((r) => r.status === 'present').length;
              const late = subRecords.filter((r) => r.status === 'late').length;
              const absent = subRecords.filter((r) => r.status === 'absent').length;
              const permission = subRecords.filter((r) => r.status === 'permission').length;
              const total = subRecords.length;

              if (total > 0) hasRecords = true;

              const subNameEscaped = sub.name.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
              msg += `📚 *${subNameEscaped}*\n`;
              msg += `  ✅ Present: ${present}\n`;
              msg += `  🕒 Late: ${late}\n`;
              msg += `  ❌ Absent: ${absent}\n`;
              msg += `  📝 Permission: ${permission}\n`;
              msg += `  📈 Marked Sessions: ${total}\n\n`;
            });

            if (!hasRecords) {
              msg += `_No class sessions were marked this week\._ \n\n`;
            }

            msg += `Use /summary for overall statistics or /export to download your complete Excel report\! 📥`;

            await safeSend(user.telegram_id, msg, null, 'weekly summary');
            sentAlerts.add(weeklySummaryKey);
          }
        }
      }
    } catch (err) {
      console.error('[Scheduler] Error in scheduler tick:', err);
    }
  });
}
