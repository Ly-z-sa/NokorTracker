import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const dbPath = process.env.DB_PATH || './nokortrack.db';
const db = new Database(dbPath);

// Enable WAL mode and foreign key support for cascade deletes
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDb() {
  // Users table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      reminder_time TEXT DEFAULT '07:00',
      timezone TEXT DEFAULT 'Asia/Phnom_Penh',
      semester_start TEXT,
      semester_end TEXT
    )
  `).run();

  // Subjects table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER,
      name TEXT NOT NULL,
      day_of_week INTEGER NOT NULL, -- 1 = Monday, 7 = Sunday (Luxon standard)
      start_time TEXT NOT NULL, -- 'HH:MM' (24-hour format)
      end_time TEXT NOT NULL, -- 'HH:MM'
      FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )
  `).run();

  // Attendance table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER,
      subject_id INTEGER,
      date TEXT NOT NULL, -- 'YYYY-MM-DD'
      status TEXT NOT NULL, -- 'present', 'absent', 'late', 'permission'
      marked_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
      FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
      UNIQUE(telegram_id, subject_id, date)
    )
  `).run();
}

// User management
export function upsertUser(telegramId, data = {}) {
  const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  if (!existing) {
    db.prepare(`
      INSERT INTO users (telegram_id, reminder_time, timezone, semester_start, semester_end)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      telegramId,
      data.reminderTime || '07:00',
      data.timezone || 'Asia/Phnom_Penh',
      data.semesterStart || null,
      data.semesterEnd || null
    );
  } else {
    const reminderTime = data.reminderTime !== undefined ? data.reminderTime : existing.reminder_time;
    const timezone = data.timezone !== undefined ? data.timezone : existing.timezone;
    const semesterStart = data.semesterStart !== undefined ? data.semesterStart : existing.semester_start;
    const semesterEnd = data.semesterEnd !== undefined ? data.semesterEnd : existing.semester_end;

    db.prepare(`
      UPDATE users
      SET reminder_time = ?, timezone = ?, semester_start = ?, semester_end = ?
      WHERE telegram_id = ?
    `).run(reminderTime, timezone, semesterStart, semesterEnd, telegramId);
  }
}

export function getUser(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}

export function getAllUsers() {
  return db.prepare('SELECT * FROM users').all();
}

export function deleteUser(telegramId) {
  return db.prepare('DELETE FROM users WHERE telegram_id = ?').run(telegramId);
}

// Subject management
export function addSubject(telegramId, name, dayOfWeek, startTime, endTime) {
  const result = db.prepare(`
    INSERT INTO subjects (telegram_id, name, day_of_week, start_time, end_time)
    VALUES (?, ?, ?, ?, ?)
  `).run(telegramId, name, dayOfWeek, startTime, endTime);
  return result.lastInsertRowid;
}

export function deleteSubject(telegramId, subjectId) {
  const result = db.prepare('DELETE FROM subjects WHERE id = ? AND telegram_id = ?').run(subjectId, telegramId);
  return result.changes > 0;
}

export function getSubjects(telegramId) {
  return db.prepare('SELECT * FROM subjects WHERE telegram_id = ? ORDER BY day_of_week, start_time').all(telegramId);
}

export function getSubjectsForDay(telegramId, dayOfWeek) {
  return db.prepare('SELECT * FROM subjects WHERE telegram_id = ? AND day_of_week = ? ORDER BY start_time').all(telegramId, dayOfWeek);
}

// Attendance management
export function markAttendance(telegramId, subjectId, date, status) {
  // Verify ownership
  const subj = db.prepare('SELECT id FROM subjects WHERE id = ? AND telegram_id = ?').get(subjectId, telegramId);
  if (!subj) throw new Error('Subject not found or unauthorized');

  db.prepare(`
    INSERT INTO attendance (telegram_id, subject_id, date, status, marked_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(telegram_id, subject_id, date) DO UPDATE SET
      status = excluded.status,
      marked_at = datetime('now')
  `).run(telegramId, subjectId, date, status);
}

export function getAttendanceForDate(telegramId, subjectId, date) {
  return db.prepare('SELECT * FROM attendance WHERE telegram_id = ? AND subject_id = ? AND date = ?').get(telegramId, subjectId, date);
}

export function getAttendanceSummary(telegramId) {
  const subjects = getSubjects(telegramId);
  const summary = [];

  for (const sub of subjects) {
    const stats = db.prepare(`
      SELECT 
        SUM(case when status = 'present' then 1 else 0 end) as present,
        SUM(case when status = 'absent' then 1 else 0 end) as absent,
        SUM(case when status = 'late' then 1 else 0 end) as late,
        SUM(case when status = 'permission' then 1 else 0 end) as permission
      FROM attendance
      WHERE telegram_id = ? AND subject_id = ?
    `).get(telegramId, sub.id);

    summary.push({
      subjectId: sub.id,
      name: sub.name,
      present: stats.present || 0,
      absent: stats.absent || 0,
      late: stats.late || 0,
      permission: stats.permission || 0
    });
  }

  return summary;
}

export function getWeeklyAttendance(telegramId, startDate, endDate) {
  return db.prepare(`
    SELECT a.*, s.name as subject_name
    FROM attendance a
    JOIN subjects s ON a.subject_id = s.id
    WHERE a.telegram_id = ? AND a.date >= ? AND a.date <= ?
    ORDER BY a.date, s.start_time
  `).all(telegramId, startDate, endDate);
}

export function getAttendanceForExport(telegramId) {
  return db.prepare(`
    SELECT a.date, s.name as subject_name, s.start_time, s.end_time, a.status, a.marked_at
    FROM attendance a
    JOIN subjects s ON a.subject_id = s.id
    WHERE a.telegram_id = ?
    ORDER BY a.date DESC, s.start_time DESC
  `).all(telegramId);
}
