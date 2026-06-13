import ExcelJS from 'exceljs';
import { getAttendanceSummary, getAttendanceForExport } from './db.js';
import { DateTime } from 'luxon';

/**
 * Generates an Excel workbook buffer for the user's attendance.
 * Sheet 1: Attendance Summary (per subject)
 * Sheet 2: Detailed Log (each marked class session)
 * 
 * @param {number} telegramId - The Telegram ID of the user.
 * @returns {Promise<Buffer>} - Buffer of the xlsx file.
 */
export async function generateAttendanceExcel(telegramId) {
  const summaryData = getAttendanceSummary(telegramId);
  const logData = getAttendanceForExport(telegramId);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NokorTrackBot';
  workbook.created = new Date();

  // ----------------------------------------------------
  // SHEET 1: ATTENDANCE SUMMARY
  // ----------------------------------------------------
  const summarySheet = workbook.addWorksheet('Attendance Summary');
  summarySheet.columns = [
    { header: 'Subject Name', key: 'name', width: 25 },
    { header: 'Present ✅', key: 'present', width: 12 },
    { header: 'Late 🕒', key: 'late', width: 12 },
    { header: 'Absent ❌', key: 'absent', width: 12 },
    { header: 'Permission 📝', key: 'permission', width: 16 },
    { header: 'Total Sessions', key: 'total', width: 16 },
    { header: 'Attendance Rate', key: 'rate', width: 20 }
  ];

  // Header row formatting
  const headerRow1 = summarySheet.getRow(1);
  headerRow1.height = 28;
  headerRow1.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  headerRow1.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow1.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1F4E78' } // Navy blue accent
    };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      bottom: { style: 'medium', color: { argb: 'FF000000' } },
      left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      right: { style: 'thin', color: { argb: 'FFD9D9D9' } }
    };
  });

  summaryData.forEach((row) => {
    const total = row.present + row.late + row.absent + row.permission;
    // Rate calculates: (Present + Late) / Total
    const rateVal = total > 0 ? (row.present + row.late) / total : 0;
    const rateFormatted = total > 0 ? `${Math.round(rateVal * 100)}%` : 'N/A';

    const newRow = summarySheet.addRow({
      name: row.name,
      present: row.present,
      late: row.late,
      absent: row.absent,
      permission: row.permission,
      total,
      rate: rateFormatted
    });

    newRow.height = 20;
    newRow.alignment = { vertical: 'middle' };
    // Center alignment for counts
    newRow.getCell('present').alignment = { horizontal: 'center', vertical: 'middle' };
    newRow.getCell('late').alignment = { horizontal: 'center', vertical: 'middle' };
    newRow.getCell('absent').alignment = { horizontal: 'center', vertical: 'middle' };
    newRow.getCell('permission').alignment = { horizontal: 'center', vertical: 'middle' };
    newRow.getCell('total').alignment = { horizontal: 'center', vertical: 'middle' };
    newRow.getCell('rate').alignment = { horizontal: 'center', vertical: 'middle' };

    // Format Rate cell
    if (total > 0) {
      const rateCell = newRow.getCell('rate');
      rateCell.font = { bold: true, color: { argb: rateVal >= 0.8 ? 'FF375623' : 'FFC00000' } };
    }
  });

  // Add borders to all data rows
  summarySheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
      };
    });
  });

  // ----------------------------------------------------
  // SHEET 2: DETAILED ATTENDANCE LOG
  // ----------------------------------------------------
  const logSheet = workbook.addWorksheet('Detailed Log');
  logSheet.columns = [
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Day of Week', key: 'day', width: 14 },
    { header: 'Subject Name', key: 'subject', width: 25 },
    { header: 'Class Time', key: 'time', width: 18 },
    { header: 'Status', key: 'status', width: 15 },
    { header: 'Marked At (Local)', key: 'markedAt', width: 22 }
  ];

  // Header row formatting
  const headerRow2 = logSheet.getRow(1);
  headerRow2.height = 28;
  headerRow2.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  headerRow2.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow2.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1F4E78' }
    };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      bottom: { style: 'medium', color: { argb: 'FF000000' } },
      left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      right: { style: 'thin', color: { argb: 'FFD9D9D9' } }
    };
  });

  logData.forEach((row) => {
    const dt = DateTime.fromISO(row.date);
    const dayName = dt.isValid ? dt.toFormat('EEEE') : 'Unknown';
    const classTime = `${row.start_time} - ${row.end_time}`;
    const statusFormatted = row.status.charAt(0).toUpperCase() + row.status.slice(1);
    
    let markedAtFormatted = 'N/A';
    if (row.marked_at) {
      // Parse database timestamp (stored as UTC) and convert to local time zone for presentation
      const markedDt = DateTime.fromSQL(row.marked_at, { zone: 'utc' }).toLocal();
      markedAtFormatted = markedDt.isValid ? markedDt.toFormat('yyyy-MM-dd HH:mm:ss') : row.marked_at;
    }

    const newRow = logSheet.addRow({
      date: row.date,
      day: dayName,
      subject: row.subject_name,
      time: classTime,
      status: statusFormatted,
      markedAt: markedAtFormatted
    });

    newRow.height = 20;
    newRow.alignment = { vertical: 'middle' };
    newRow.getCell('date').alignment = { horizontal: 'center', vertical: 'middle' };
    newRow.getCell('day').alignment = { horizontal: 'center', vertical: 'middle' };
    newRow.getCell('time').alignment = { horizontal: 'center', vertical: 'middle' };
    newRow.getCell('status').alignment = { horizontal: 'center', vertical: 'middle' };
    newRow.getCell('markedAt').alignment = { horizontal: 'center', vertical: 'middle' };

    // Set colors for the Status cells
    const statusCell = newRow.getCell('status');
    const val = row.status.toLowerCase();
    let bgCol = null;
    let fgCol = null;

    if (val === 'present') {
      bgCol = 'FFE2EFDA'; // Light green
      fgCol = 'FF375623'; // Dark green text
    } else if (val === 'absent') {
      bgCol = 'FFFCE4D6'; // Light red/orange
      fgCol = 'FFC00000'; // Red text
    } else if (val === 'late') {
      bgCol = 'FFFFF2CC'; // Light yellow
      fgCol = 'FF7F6000'; // Dark yellow text
    } else if (val === 'permission') {
      bgCol = 'FFD9E1F2'; // Light blue
      fgCol = 'FF1F4E78'; // Dark blue text
    }

    if (bgCol) {
      statusCell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: bgCol }
      };
      statusCell.font = { bold: true, color: { argb: fgCol } };
    }
  });

  // Borders for data rows in log sheet
  logSheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
      };
    });
  });

  return await workbook.xlsx.writeBuffer();
}
