require("dotenv").config();

const express = require("express");
const { google } = require("googleapis");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Google Sheets authentication
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n")
  },
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets"
  ]
});

const sheets = google.sheets({
  version: "v4",
  auth
});

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;

// Philippine local timestamp
function getPhilippineTimestamp() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const value = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return `${value.year}-${value.month}-${value.day} ` +
         `${value.hour}:${value.minute}:${value.second}`;
}

// Check server configuration
function checkConfiguration() {
  const required = [
    "GOOGLE_SHEET_ID",
    "GOOGLE_SERVICE_ACCOUNT_EMAIL",
    "GOOGLE_PRIVATE_KEY"
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

// Attendance endpoint
app.post("/api/attendance", async (req, res) => {
  try {
    const lrn = String(req.body.lrn || "").trim();

    // Basic LRN validation
    if (!/^\d{1,20}$/.test(lrn)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid numeric LRN."
      });
    }

    // Get registered students from Google Sheets
    const studentResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Students!A2:B"
    });

    const students = studentResponse.data.values || [];

    // Compare LRNs as strings to preserve leading zeros
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
        message: "Your student record is incomplete. Contact your teacher."
      });
    }

    // Create a timestamp for this submission
    const timestamp = getPhilippineTimestamp();

    // APPEND a new row every time.
    // There is intentionally no duplicate-checking logic.
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Attendance!A:C",
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
    // Keep private credentials and student data out of error logs.
    console.error("Attendance operation failed:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to record attendance right now. Please try again."
    });
  }
});

// Health check for testing
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Check configuration before starting
try {
  checkConfiguration();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`QR Attendance server running on port ${PORT}`);
  });
} catch (error) {
  console.error("Startup error:", error.message);
  process.exit(1);
}