
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

// Get the current date and time in the Philippines.
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

// Find today's spreadsheet or create it if it doesn't exist.
async function getDailyAttendanceSpreadsheet(date) {
  const fileName = `Attendance - ${date}`;

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

  // Create a spreadsheet with an Attendance tab.
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: fileName
      },
      sheets: [
        {
          properties: {
            title: "Attendance"
          }
        }
      ]
    }
  });

  const newSpreadsheetId = created.data.spreadsheetId;

  try {
    // Move the new spreadsheet into the designated Drive folder.
    const file = await drive.files.get({
      fileId: newSpreadsheetId,
      fields: "parents"
    });

    const previousParents = file.data.parents || [];

    await drive.files.update({
      fileId: newSpreadsheetId,
      addParents: FOLDER_ID,
      ...(previousParents.length
        ? { removeParents: previousParents.join(",") }
        : {}),
      fields: "id,parents"
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
  } catch (error) {
    console.error(
      "Daily spreadsheet setup failed:",
      error.message
    );
    throw error;
  }
}

// Health check.
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Verify the student and record attendance in the daily spreadsheet.
app.post("/api/attendance", async (req, res) => {
  try {
    const lrn = String(req.body?.lrn || "").trim();

    if (!/^\d{1,20}$/.test(lrn)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid numeric LRN."
      });
    }

    // Check the permanent student list.
    const studentResponse =
      await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: "'Students'!A2:B"
      });

    const students = studentResponse.data.values || [];

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

    // Determine today's Philippine date.
    const { date, timestamp } = getPhilippineDateTime();

    // Find today's file or create it.
    const dailySpreadsheetId =
      await getDailyAttendanceSpreadsheet(date);

    // Save the attendance record.
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
      status: error.response?.status || null
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
