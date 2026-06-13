import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';
import { DateTime } from 'luxon';
import {
  upsertUser,
  getUser,
  addSubject,
  deleteSubject,
  getSubjects,
  getAttendanceSummary,
  markAttendance
} from './db.js';
import { generateAttendanceExcel } from './exporter.js';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is missing in the environment variables');
}

export const bot = new Telegraf(token);

// Day names mapping
export const DAYS = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday'
};

// Memory store for interactive wizard sessions
const sessions = {};

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = { step: null, data: {} };
  }
  return sessions[chatId];
}

function clearSession(chatId) {
  delete sessions[chatId];
}

// Wizard input interceptor middleware
bot.use(async (ctx, next) => {
  if (ctx.chat && ctx.message && ctx.message.text) {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      // Any command automatically cancels the current interactive wizard session
      clearSession(ctx.chat.id);
      if (text.startsWith('/cancel')) {
        return ctx.reply('❌ Current operation cancelled.');
      }
    }
    const session = getSession(ctx.chat.id);
    if (session.step) {
      try {
        await handleWizardStep(ctx, session);
        return;
      } catch (err) {
        console.error('Wizard Error:', err);
        clearSession(ctx.chat.id);
        return ctx.reply('⚠️ An error occurred during the setup. Please try again.');
      }
    }
  }
  return next();
});

// START command
bot.command('start', async (ctx) => {
  const chatId = ctx.chat.id;
  upsertUser(chatId); // Register with defaults

  const text = `🎉 **Welcome to NokorTrackBot!** 🎓\n\n` +
               `I will help you track your class attendance, send reminders, and export reports.\n\n` +
               `🚀 **Quick Start Guide:**\n` +
               `1️⃣ Set up your semester: /setup\\_semester\n` +
               `2️⃣ Add your subjects: /add\\_subject\n` +
               `3️⃣ View your schedule: /subjects\n` +
               `4️⃣ Configure reminders and timezone: /settings\n` +
               `5️⃣ View attendance stats: /summary\n` +
               `6️⃣ Export report to Excel: /export\n\n` +
               `💡 Everyday you have classes, I will send you a morning reminder. When each class starts, I will send you buttons to mark your attendance. At the end of each week, you will receive a weekly summary.\n\n` +
               `Type /cancel at any time to cancel an ongoing setup.`;

  await ctx.reply(text, { parse_mode: 'Markdown' });
});

// CANCEL command
bot.command('cancel', (ctx) => {
  clearSession(ctx.chat.id);
  ctx.reply('❌ Current operation cancelled.');
});

// SETUP SEMESTER command
bot.command(['setup_semester', 'setupsemester'], async (ctx) => {
  const chatId = ctx.chat.id;
  upsertUser(chatId); // Ensure user is registered

  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/).slice(1);
  
  if (parts.length === 2) {
    const [start, end] = parts;
    const startDt = DateTime.fromISO(start);
    const endDt = DateTime.fromISO(end);
    if (startDt.isValid && endDt.isValid && endDt >= startDt) {
      upsertUser(chatId, { semesterStart: start, semesterEnd: end });
      return ctx.reply(`✅ **Semester Configured!**\n📅 Start: ${start}\n📅 End: ${end}`);
    }
  }

  // Start interactive session
  const session = getSession(chatId);
  session.step = 'setup_semester_start';
  await ctx.reply('📅 Let\'s setup your semester.\n\nPlease enter the Semester Start Date in format `YYYY-MM-DD` (e.g., 2026-06-01):');
});

// ADD SUBJECT command
bot.command(['add_subject', 'addsubject'], async (ctx) => {
  const chatId = ctx.chat.id;
  const user = getUser(chatId);
  if (!user || !user.semester_start || !user.semester_end) {
    return ctx.reply('⚠️ Please set up your semester dates first using /setup\\_semester.');
  }

  const session = getSession(chatId);
  session.step = 'add_subject_name';
  await ctx.reply('📚 Let\'s add a subject to your schedule.\n\nWhat is the name of the subject? (e.g., Mathematics):');
});

// Helper to list subjects
async function listSubjects(ctx, chatId) {
  const user = getUser(chatId);
  if (!user || !user.semester_start || !user.semester_end) {
    return ctx.reply('⚠️ Please set up your semester first using /setup\\_semester');
  }

  const subjects = getSubjects(chatId);
  if (subjects.length === 0) {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ Add Subject', 'action:add_subject')]
    ]);
    return ctx.reply('📚 You have not added any subjects yet. Use the button below to add one:', keyboard);
  }

  let text = `📅 **Semester Schedule**\n` +
             `Period: \`${user.semester_start}\` to \`${user.semester_end}\`\n\n` +
             `Here are your subjects:`;

  await ctx.reply(text, { parse_mode: 'Markdown' });

  // Send each subject as a card with a delete button
  for (const sub of subjects) {
    const subNameEscaped = sub.name.replace(/_/g, '\\_');
    const subText = `📚 **${subNameEscaped}**\n📅 ${DAYS[sub.day_of_week]}\n⏰ ${sub.start_time} - ${sub.end_time}`;
    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback('❌ Delete Subject', `delete:${sub.id}`)
    ]);
    await ctx.reply(subText, { parse_mode: 'Markdown', ...keyboard });
  }
}

// SUBJECTS list command
bot.command('subjects', async (ctx) => {
  await listSubjects(ctx, ctx.chat.id);
});

// SETTINGS command
bot.command('settings', async (ctx) => {
  const chatId = ctx.chat.id;
  upsertUser(chatId);
  const user = getUser(chatId);

  const text = `⚙️ **Settings**\n\n` +
               `⏰ **Morning Reminder Time**: ${user.reminder_time}\n` +
               `🌍 **Timezone**: \`${user.timezone}\`\n` +
               `📅 **Semester**: ${user.semester_start || 'Not Set'} to ${user.semester_end || 'Not Set'}\n\n` +
               `Use the buttons below to change settings:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('⏰ Set Reminder Time', 'setting:reminder')],
    [Markup.button.callback('🌍 Set Timezone', 'setting:timezone')],
    [Markup.button.callback('📅 Set Semester Dates', 'setting:semester')]
  ]);

  await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
});

// SUMMARY command
bot.command('summary', async (ctx) => {
  const chatId = ctx.chat.id;
  const summary = getAttendanceSummary(chatId);
  
  if (summary.length === 0) {
    return ctx.reply('📊 You have no subjects configured. Use /add\\_subject to add some.');
  }

  let text = `📊 **Attendance Summary**\n\n`;
  let totalAllPresent = 0;
  let totalAllSessions = 0;

  for (const s of summary) {
    const total = s.present + s.late + s.absent + s.permission;
    totalAllSessions += total;
    totalAllPresent += s.present + s.late;
    
    const rate = total > 0 ? Math.round(((s.present + s.late) / total) * 100) : 0;
    const rateStr = total > 0 ? `${rate}%` : 'N/A';

    const sNameEscaped = s.name.replace(/_/g, '\\_');
    text += `📚 **${sNameEscaped}**\n`;
    text += `  ✅ Present: ${s.present}\n`;
    text += `  🕒 Late: ${s.late}\n`;
    text += `  ❌ Absent: ${s.absent}\n`;
    text += `  📝 Permission: ${s.permission}\n`;
    text += `  📈 Rate: *${rateStr}* (Total: ${total})\n\n`;
  }

  if (totalAllSessions > 0) {
    const overallRate = Math.round((totalAllPresent / totalAllSessions) * 100);
    text += `───────────────────\n`;
    text += `🎓 **Overall Attendance Rate**: *${overallRate}%*\n`;
  } else {
    text += `_No class sessions have been marked yet._`;
  }

  const keyboard = Markup.inlineKeyboard([
    Markup.button.callback('📥 Export Excel Report', 'action:export')
  ]);

  await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
});

// EXPORT command
bot.command('export', async (ctx) => {
  const chatId = ctx.chat.id;
  await handleExportAction(ctx, chatId);
});

// ----------------------------------------------------
// ACTIONS & CALLBACK QUERIES
// ----------------------------------------------------

// Interactive subject addition trigger
bot.action('action:add_subject', async (ctx) => {
  const chatId = ctx.chat.id;
  const user = getUser(chatId);
  if (!user || !user.semester_start || !user.semester_end) {
    await ctx.answerCbQuery();
    return ctx.reply('⚠️ Please set up your semester dates first using /setup\\_semester.');
  }

  const session = getSession(chatId);
  session.step = 'add_subject_name';
  await ctx.answerCbQuery();
  await ctx.reply('📚 Let\'s add a subject to your schedule.\n\nWhat is the name of the subject? (e.g., Mathematics):');
});

// Interactive schedule viewing trigger
bot.action('action:view_subjects', async (ctx) => {
  const chatId = ctx.chat.id;
  await ctx.answerCbQuery();
  await listSubjects(ctx, chatId);
});

// Handle Day select buttons in subject creation
bot.action(/^day:(\d)$/, async (ctx) => {
  const chatId = ctx.chat.id;
  const session = getSession(chatId);
  
  if (session.step === 'add_subject_day') {
    session.data.dayOfWeek = parseInt(ctx.match[1]);
    session.step = 'add_subject_start';
    await ctx.answerCbQuery();
    await ctx.reply(`📅 Day set to **${DAYS[session.data.dayOfWeek]}**.\n\nNow enter the Class Start Time in 24-hour format \`HH:MM\` (e.g., 08:00 or 14:30):`, { parse_mode: 'Markdown' });
  }
});

// Handle setting triggers
bot.action('setting:reminder', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = getSession(chatId);
  session.step = 'set_reminder_time';
  await ctx.answerCbQuery();
  await ctx.reply('⏰ Please enter your morning reminder time in 24-hour format `HH:MM` (e.g., 07:00, 08:30):');
});

bot.action('setting:timezone', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = getSession(chatId);
  session.step = 'set_timezone';
  await ctx.answerCbQuery();
  await ctx.reply('🌍 Please enter your timezone name (e.g., Asia/Phnom_Penh, Asia/Bangkok, UTC):');
});

bot.action('setting:semester', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = getSession(chatId);
  session.step = 'setup_semester_start';
  await ctx.answerCbQuery();
  await ctx.reply('📅 Please enter your Semester Start Date in format `YYYY-MM-DD` (e.g., 2026-06-01):');
});

// Cancel setting callback
bot.action('action:cancel', async (ctx) => {
  clearSession(ctx.chat.id);
  await ctx.answerCbQuery('Cancelled');
  await ctx.reply('❌ Current operation cancelled.');
});

// Export report callback
bot.action('action:export', async (ctx) => {
  const chatId = ctx.chat.id;
  await ctx.answerCbQuery('Generating Excel report...');
  await handleExportAction(ctx, chatId);
});

// Delete subject callback
bot.action(/^delete:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat.id;
  const subjectId = parseInt(ctx.match[1]);
  const success = deleteSubject(chatId, subjectId);
  if (success) {
    await ctx.answerCbQuery('Subject deleted');
    await ctx.editMessageText('❌ _Subject deleted from your schedule._', { parse_mode: 'Markdown' });
  } else {
    await ctx.answerCbQuery('Failed to delete subject');
  }
});

// Attendance marking callback
bot.action(/^mark:(\d+):([\d-]+):(\w+)$/, async (ctx) => {
  const chatId = ctx.chat.id;
  const subjectId = parseInt(ctx.match[1]);
  const dateStr = ctx.match[2];
  const status = ctx.match[3];

  try {
    markAttendance(chatId, subjectId, dateStr, status);
    
    // Find subject name
    const subjects = getSubjects(chatId);
    const subject = subjects.find(s => s.id === subjectId);
    const subjectName = subject ? subject.name : 'Subject';

    const statusIcons = {
      present: '✅ Present',
      absent: '❌ Absent',
      late: '🕒 Late',
      permission: '📝 Permission'
    };

    const statusText = statusIcons[status] || status;
    const timeFormatted = DateTime.now().setZone('Asia/Phnom_Penh').toFormat('hh:mm a');

    await ctx.answerCbQuery(`Marked as ${status}`);
    
    // Maintain keyboard buttons in case they want to change their response
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(status === 'present' ? '✅ Present' : 'Present', `mark:${subjectId}:${dateStr}:present`),
        Markup.button.callback(status === 'absent' ? '❌ Absent' : 'Absent', `mark:${subjectId}:${dateStr}:absent`)
      ],
      [
        Markup.button.callback(status === 'late' ? '🕒 Late' : 'Late', `mark:${subjectId}:${dateStr}:late`),
        Markup.button.callback(status === 'permission' ? '📝 Permission' : 'Permission', `mark:${subjectId}:${dateStr}:permission`)
      ]
    ]);

    const escapedSubjectName = subjectName.replace(/_/g, '\\_');
    await ctx.editMessageText(
      `🔔 **Attendance Marked!**\n\n` +
      `📚 Subject: **${escapedSubjectName}**\n` +
      `📅 Date: ${dateStr}\n` +
      `📌 Status: **${statusText}**\n` +
      `⏰ Updated at: ${timeFormatted}\n\n` +
      `You can modify your entry below:`,
      { parse_mode: 'Markdown', ...keyboard }
    );
  } catch (err) {
    console.error('Mark Attendance Error:', err);
    await ctx.answerCbQuery('Error marking attendance');
  }
});

// ----------------------------------------------------
// EXPORT HELPER
// ----------------------------------------------------
async function handleExportAction(ctx, chatId) {
  try {
    const buffer = await generateAttendanceExcel(chatId);
    const dateFormatted = DateTime.now().toFormat('yyyyMMdd');
    await ctx.replyWithDocument({
      source: buffer,
      filename: `Attendance_Report_${dateFormatted}.xlsx`
    }, {
      caption: '📊 **Here is your attendance report!**'
    });
  } catch (err) {
    console.error('Export Error:', err);
    await ctx.reply('⚠️ Failed to generate Excel report. Make sure you have added subjects and marked attendance.');
  }
}

// ----------------------------------------------------
// WIZARD STATE MANAGER
// ----------------------------------------------------
async function handleWizardStep(ctx, session) {
  const text = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  switch (session.step) {
    case 'setup_semester_start': {
      const dt = DateTime.fromISO(text);
      if (dt.isValid) {
        session.data.semesterStart = text;
        session.step = 'setup_semester_end';
        await ctx.reply(`📅 Semester Start Date set to **${text}**.\n\nNow enter the Semester End Date in format \`YYYY-MM-DD\` (e.g., 2026-10-31):`, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply('⚠️ Invalid date format. Please enter the Semester Start Date in format `YYYY-MM-DD` (e.g., 2026-06-01):');
      }
      break;
    }

    case 'setup_semester_end': {
      const dt = DateTime.fromISO(text);
      const startDt = DateTime.fromISO(session.data.semesterStart);
      if (dt.isValid && dt >= startDt) {
        upsertUser(chatId, {
          semesterStart: session.data.semesterStart,
          semesterEnd: text
        });
        clearSession(chatId);
        await ctx.reply(`✅ **Semester Configured!**\n\n📅 Start Date: \`${session.data.semesterStart}\`\n📅 End Date: \`${text}\`\n\nYou can now add subjects using /add\\_subject`, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply('⚠️ Invalid date format or date is before start date. Please enter the Semester End Date in format `YYYY-MM-DD` (e.g., 2026-10-31):');
      }
      break;
    }

    case 'add_subject_name': {
      session.data.name = text;
      session.step = 'add_subject_day';
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Monday', 'day:1'), Markup.button.callback('Tuesday', 'day:2')],
        [Markup.button.callback('Wednesday', 'day:3'), Markup.button.callback('Thursday', 'day:4')],
        [Markup.button.callback('Friday', 'day:5'), Markup.button.callback('Saturday', 'day:6')],
        [Markup.button.callback('Sunday', 'day:7')],
        [Markup.button.callback('❌ Cancel', 'action:cancel')]
      ]);
      const escapedText = text.replace(/_/g, '\\_');
      await ctx.reply(`Subject Name: **${escapedText}**\n\nWhich day of the week is this class?`, { parse_mode: 'Markdown', ...keyboard });
      break;
    }

    case 'add_subject_start': {
      const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
      if (timeRegex.test(text)) {
        session.data.startTime = text;
        session.step = 'add_subject_end';
        await ctx.reply(`⏰ Start Time set to **${text}**.\n\nNow enter the Class End Time in 24-hour format \`HH:MM\` (e.g., 10:30 or 17:00):`, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply('⚠️ Invalid time format. Please enter start time in 24-hour format `HH:MM` (e.g., 08:00 or 14:30):');
      }
      break;
    }

    case 'add_subject_end': {
      const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
      if (timeRegex.test(text)) {
        const [sh, sm] = session.data.startTime.split(':').map(Number);
        const [eh, em] = text.split(':').map(Number);
        const startMins = sh * 60 + sm;
        const endMins = eh * 60 + em;

        if (endMins > startMins) {
          addSubject(chatId, session.data.name, session.data.dayOfWeek, session.data.startTime, text);
          clearSession(chatId);
          const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('➕ Add Another Subject', 'action:add_subject')],
            [Markup.button.callback('📅 View Schedule', 'action:view_subjects')]
          ]);
          const escapedSubName = session.data.name.replace(/_/g, '\\_');
          await ctx.reply(`✅ **Subject Added!**\n\n📚 Subject: **${escapedSubName}**\n📅 Day: ${DAYS[session.data.dayOfWeek]}\n⏰ Time: ${session.data.startTime} - ${text}`, { parse_mode: 'Markdown', ...keyboard });
        } else {
          await ctx.reply('⚠️ End time must be after start time. Please enter the Class End Time in `HH:MM` format:');
        }
      } else {
        await ctx.reply('⚠️ Invalid time format. Please enter end time in 24-hour format `HH:MM` (e.g., 10:30 or 17:00):');
      }
      break;
    }

    case 'set_reminder_time': {
      const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
      if (timeRegex.test(text)) {
        upsertUser(chatId, { reminderTime: text });
        clearSession(chatId);
        await ctx.reply(`✅ Morning reminder time set to **${text}**.`);
      } else {
        await ctx.reply('⚠️ Invalid time format. Please enter your reminder time in 24-hour format `HH:MM` (e.g., 07:30):');
      }
      break;
    }

    case 'set_timezone': {
      const tempDt = DateTime.now().setZone(text);
      if (tempDt.isValid) {
        upsertUser(chatId, { timezone: text });
        clearSession(chatId);
        await ctx.reply(`✅ Timezone updated to **${text}**.\n\nCurrent local time: ${tempDt.toFormat('yyyy-MM-dd hh:mm a')}`);
      } else {
        await ctx.reply('⚠️ Invalid timezone name. Please enter a valid IANA timezone name (e.g., Asia/Phnom_Penh, Asia/Bangkok, UTC):');
      }
      break;
    }

    default:
      clearSession(chatId);
      await ctx.reply('Something went wrong. Current operation cancelled.');
      break;
  }
}
