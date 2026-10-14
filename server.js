
require("dotenv").config();

const express = require("express");
const { google } = require("googleapis");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

function normalizePrivateKey(value) {
  let key = String(value || "").trim();

  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }

  return key.replace(/\\n/g, "\n");
}

const privateKey = normalizePrivateKey(
  process.env.GOOGLE_PRIVATE_KEY
);

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const SERVICE_ACCOUNT_EMAIL =
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;

function checkConfiguration() {
  const required = [
    "GOOGLE_SHEET_ID",
    "GOOGLE_SERVICE_ACCOUNT_EMAIL",
    "GOOGLE_PRIVATE_KEY",
    "GOOGLE_DRIVE_FOLDER_ID"
  ];

  const missing = required.filter(
    key => !process.env[key]
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}`
    );
  }
}

checkConfiguration();

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: SERVICE_ACCOUNT_EMAIL,
    private_key: privateKey
  },
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive"
  ]
});

const sheets = google.sheets({
  version: "v4",
  auth
});

const drive = google.drive({
  version: "v3",
  auth
});

// Get the current Philippine date and time.
function getPhilippineDateTime() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    timestamp:
      `${values.year}-${values.month}-${values.day} ` +
      `${values.hour}:${values.minute}:${values.second}`
  };
}

// Find today's spreadsheet or create it inside the Drive folder.
async function getDailyAttendanceSpreadsheet(date) {
  const fileName = `Attendance - ${date}`;

  // Look for an existing spreadsheet for today's date.
  const search = await drive.files.list({
    q:
      `'${FOLDER_ID}' in parents and ` +
      `name = '${fileName}' and ` +
      `mimeType = 'application/vnd.google-apps.spreadsheet' and ` +
      `trashed = false`,
    pageSize: 100,
    fields: "files(id,name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  const existingFiles = search.data.files || [];

  if (existingFiles.length > 0) {
    return existingFiles[0].id;
  }

  // Create the spreadsheet directly inside the folder.
  const created = await drive.files.create({
    requestBody: {
      name: fileName,
      mimeType: "application/vnd.google-apps.spreadsheet",
      parents: [FOLDER_ID]
    },
    fields: "id,name,parents",
    supportsAllDrives: true
  });

  const newSpreadsheetId = created.data.id;

  // Get the default worksheet.
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: newSpreadsheetId
  });

  const firstSheet = spreadsheet.data.sheets?.[0];

  if (!firstSheet) {
    throw new Error("The new spreadsheet has no worksheet.");
  }

  // Rename the worksheet to Attendance.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: newSpreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId: firstSheet.properties.sheetId,
              title: "Attendance"
            },
            fields: "title"
          }
        }
      ]
    }
  });

  // Add the column headings.
  await sheets.spreadsheets.values.update({
    spreadsheetId: newSpreadsheetId,
    range: "'Attendance'!A1:C1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        "Timestamp",
        "LRN",
        "Student Name"
      ]]
    }
  });

  console.log(`Created daily spreadsheet: ${fileName}`);

  return newSpreadsheetId;
}

// Health check.
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Verify the student and record attendance.
app.post("/api/attendance", async (req, res) => {
  try {
    const lrn = String(req.body?.lrn || "").trim();

    // Validate the LRN.
    if (!/^\d{1,20}$/.test(lrn)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid numeric LRN."
      });
    }

    // Read the permanent student list.
    const studentResponse =
      await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: "'Students'!A2:B"
      });

    const students = studentResponse.data.values || [];

    // Compare LRNs as strings to preserve leading zeros.
    const student = students.find(row =>
      String(row[0] ?? "").trim() === lrn
    );

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "LRN not found. Please check your number."
      });
    }

    const studentName = String(student[1] || "").trim();

    if (!studentName) {
      return res.status(400).json({
        success: false,
        message:
          "The student record has no name. Please contact your teacher."
      });
    }

    // Get the Philippine date and timestamp.
    const { date, timestamp } = getPhilippineDateTime();

    // Find or create today's attendance spreadsheet.
    const dailySpreadsheetId =
      await getDailyAttendanceSpreadsheet(date);

    // Record attendance in today's spreadsheet.
    await sheets.spreadsheets.values.append({
      spreadsheetId: dailySpreadsheetId,
      range: "'Attendance'!A:C",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[timestamp, lrn, studentName]]
      }
    });

    return res.status(200).json({
      success: true,
      message: "Attendance recorded successfully!",
      studentName,
      timestamp
    });

  } catch (error) {
    console.error("Attendance operation failed:", {
      message: error.message,
      code: error.code || null,
      status: error.response?.status || null,
      details: error.response?.data?.error?.errors || null
    });

    return res.status(500).json({
      success: false,
      message:
        "Unable to record attendance right now. Please try again."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`QR Attendance server running on port ${PORT}`);
});
