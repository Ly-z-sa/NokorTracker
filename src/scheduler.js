import cron from 'node-cron';
import { DateTime } from 'luxon';
import { bot, DAYS } from './bot.js';
import { getAllUsers, getSubjectsForDay, getWeeklyAttendance, getSubjects } from './db.js';
import { Markup } from 'telegraf';

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

      for (const user of users) {
        const timezone = user.timezone || 'Asia/Phnom_Penh';
        const localNow = DateTime.now().setZone(timezone);
        const currentTimeStr = localNow.toFormat('HH:mm');
        const currentDateStr = localNow.toFormat('yyyy-MM-dd');

        // Check if user has defined semester dates
        if (!user.semester_start || !user.semester_end) {
          continue;
        }

        // Check if today is within the semester
        const semesterStart = DateTime.fromISO(user.semester_start, { zone: timezone }).startOf('day');
        const semesterEnd = DateTime.fromISO(user.semester_end, { zone: timezone }).endOf('day');
        const isSemesterActive = localNow >= semesterStart && localNow <= semesterEnd;

        if (!isSemesterActive) {
          continue;
        }

        const dayOfWeek = localNow.dayOfWeek; // 1 = Monday, 7 = Sunday

        // ----------------------------------------------------
        // 1. MORNING CLASS REMINDER
        // ----------------------------------------------------
        if (currentTimeStr === user.reminder_time) {
          const todaysSubjects = getSubjectsForDay(user.telegram_id, dayOfWeek);
          if (todaysSubjects.length > 0) {
            let msg = `⏰ **Morning Class Reminder!** 📚\n\n`;
            msg += `Today (${currentDateStr}, ${DAYS[dayOfWeek]}) you have the following classes:\n\n`;
            todaysSubjects.forEach((s) => {
              const sNameEscaped = s.name.replace(/_/g, '\\_');
              msg += `• **${sNameEscaped}**: ${s.start_time} - ${s.end_time}\n`;
            });
            msg += `\nHave a great day in class! 🚀`;

            await bot.telegram.sendMessage(user.telegram_id, msg, { parse_mode: 'Markdown' })
              .catch((err) => console.error(`[Scheduler] Failed to send morning reminder to ${user.telegram_id}:`, err.message));
          }
        }

        // ----------------------------------------------------
        // 2. CLASS START ATTENDANCE ALERT
        // ----------------------------------------------------
        const allSubjects = getSubjects(user.telegram_id);
        for (const subject of allSubjects) {
          if (subject.day_of_week === dayOfWeek && subject.start_time === currentTimeStr) {
            let msg = `🔔 **Class Session Started!** 🏫\n\n`;
            const subNameEscaped = subject.name.replace(/_/g, '\\_');
            msg += `📚 Subject: **${subNameEscaped}**\n`;
            msg += `⏰ Time: ${subject.start_time} - ${subject.end_time}\n`;
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

            await bot.telegram.sendMessage(user.telegram_id, msg, { parse_mode: 'Markdown', ...keyboard })
              .catch((err) => console.error(`[Scheduler] Failed to send class start alert to ${user.telegram_id}:`, err.message));
          }
        }

        // ----------------------------------------------------
        // 3. WEEKLY ATTENDANCE SUMMARY
        // ----------------------------------------------------
        // Runs on Sunday at 20:00 (8:00 PM) local time
        if (dayOfWeek === 7 && currentTimeStr === '20:00') {
          const startOfWeek = localNow.startOf('week'); // Monday
          const endOfWeek = localNow.endOf('week'); // Sunday
          const startOfWeekStr = startOfWeek.toFormat('yyyy-MM-dd');
          const endOfWeekStr = endOfWeek.toFormat('yyyy-MM-dd');

          const weeklyRecords = getWeeklyAttendance(user.telegram_id, startOfWeekStr, endOfWeekStr);
          const subjects = getSubjects(user.telegram_id);

          if (subjects.length > 0) {
            let msg = `📊 **Weekly Attendance Summary** 🎓\n`;
            msg += `Period: \`${startOfWeekStr}\` to \`${endOfWeekStr}\`\n\n`;

            let hasRecords = false;

            subjects.forEach((sub) => {
              const subRecords = weeklyRecords.filter((r) => r.subject_id === sub.id);
              
              const present = subRecords.filter((r) => r.status === 'present').length;
              const late = subRecords.filter((r) => r.status === 'late').length;
              const absent = subRecords.filter((r) => r.status === 'absent').length;
              const permission = subRecords.filter((r) => r.status === 'permission').length;
              const total = subRecords.length;

              if (total > 0) {
                hasRecords = true;
              }

              const subNameEscaped = sub.name.replace(/_/g, '\\_');
              msg += `📚 **${subNameEscaped}**\n`;
              msg += `  ✅ Present: ${present}\n`;
              msg += `  🕒 Late: ${late}\n`;
              msg += `  ❌ Absent: ${absent}\n`;
              msg += `  📝 Permission: ${permission}\n`;
              msg += `  📈 Marked Sessions: ${total}\n\n`;
            });

            if (!hasRecords) {
              msg += `_No class sessions were marked this week._\n\n`;
            }

            msg += `Use /summary for overall statistics or /export to download your complete Excel report! 📥`;

            await bot.telegram.sendMessage(user.telegram_id, msg, { parse_mode: 'Markdown' })
              .catch((err) => console.error(`[Scheduler] Failed to send weekly summary to ${user.telegram_id}:`, err.message));
          }
        }
      }
    } catch (err) {
      console.error('[Scheduler] Error in scheduler tick:', err);
    }
  });
}
