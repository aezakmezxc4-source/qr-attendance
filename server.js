
require("dotenv").config();

const express = require("express");
const { google } = require("googleapis");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Normalize the private key from Render environment variables.
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

// Verify environment variables.
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

// Authenticate with Google Sheets.
checkConfiguration();

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: privateKey
  },
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets"
  ]
});

const sheets = google.sheets({
  version: "v4",
  auth
});

// Philippine date and time.
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

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return (
    `${values.year}-${values.month}-${values.day} ` +
    `${values.hour}:${values.minute}:${values.second}`
  );
}

// Check that the server is running.
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Record attendance after verifying the student's LRN.
app.post("/api/attendance", async (req, res) => {
  try {
    const lrn = String(req.body?.lrn || "").trim();

    // Reject empty or non-numeric LRNs.
    if (!/^\d{1,20}$/.test(lrn)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid numeric LRN."
      });
    }

    // Read the registered student list.
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

    // Do not record unregistered students.
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

    // Generate the timestamp after verifying the student.
    const timestamp = getPhilippineTimestamp();

    // Save attendance to the original spreadsheet.
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
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
  console.log(
    `QR Attendance server running on port ${PORT}`
  );
});
