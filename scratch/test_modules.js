import {
  initDb,
  upsertUser,
  getUser,
  addSubject,
  getSubjects,
  markAttendance,
  getAttendanceSummary,
  getAttendanceForExport,
  deleteUser
} from '../src/db.js';
import { generateAttendanceExcel } from '../src/exporter.js';
import fs from 'fs';
import path from 'path';

async function runTests() {
  console.log('🧪 Starting Module Verification Tests...');
  
  // 1. Initialize DB
  initDb();
  console.log('✅ Database initialization query executed.');

  const testUserId = 999999;
  // Clean up any test user data from previous runs
  deleteUser(testUserId);
  console.log('🧹 Cleaned up any stale test user data.');

  // 2. Register/Upsert User
  upsertUser(testUserId, {
    reminderTime: '08:15',
    timezone: 'Asia/Phnom_Penh',
    semesterStart: '2026-06-01',
    semesterEnd: '2026-10-31'
  });
  
  const user = getUser(testUserId);
  if (user && user.reminder_time === '08:15' && user.timezone === 'Asia/Phnom_Penh') {
    console.log('✅ User registration/upsert verified:', user);
  } else {
    throw new Error('User registration verification failed');
  }

  // 3. Add Subject
  const subId = addSubject(testUserId, 'Advanced Algorithms', 1, '08:00', '10:00');
  console.log('✅ Subject added with ID:', subId);

  const subjects = getSubjects(testUserId);
  if (subjects.length > 0 && subjects[0].name === 'Advanced Algorithms') {
    console.log('✅ Subject query verified:', subjects);
  } else {
    throw new Error('Subject query verification failed');
  }

  // 4. Mark Attendance
  markAttendance(testUserId, subId, '2026-06-01', 'present');
  markAttendance(testUserId, subId, '2026-06-08', 'late');
  markAttendance(testUserId, subId, '2026-06-15', 'absent');
  markAttendance(testUserId, subId, '2026-06-22', 'permission');
  console.log('✅ Attendance marking executed successfully.');

  // 5. Query Summary & Logs
  const summary = getAttendanceSummary(testUserId);
  console.log('✅ Summary report stats generated:', summary);

  const logData = getAttendanceForExport(testUserId);
  if (logData.length === 4) {
    console.log('✅ Detailed logs query verified, record count matches.');
  } else {
    throw new Error(`Expected 4 log records, but got ${logData.length}`);
  }

  // 6. Generate Excel Report
  console.log('Generating Excel sheet...');
  const buffer = await generateAttendanceExcel(testUserId);
  
  const testDir = './scratch';
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir);
  }
  
  fs.writeFileSync(path.join(testDir, 'test_report.xlsx'), buffer);
  console.log('✅ Excel report successfully generated and saved to scratch/test_report.xlsx');
  console.log('🎉 All module tests passed successfully!');
}

runTests().catch(err => {
  console.error('❌ Verification Tests Failed:', err);
  process.exit(1);
});
