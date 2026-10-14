
require("dotenv").config();

const express = require("express");
const { google } = require("googleapis");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Normalize the private key from the environment variable.
function normalizePrivateKey(value) {
  let key = String(value || "").trim();

  // Remove surrounding quotes if accidentally included.
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }

  // Convert literal \n sequences into actual newlines.
  return key.replace(/\\n/g, "\n");
}

const privateKey = normalizePrivateKey(
  process.env.GOOGLE_PRIVATE_KEY
);

// Check required environment variables.
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

  // Validate the key without printing the secret.
  try {
    crypto.createPrivateKey(privateKey);
    console.log("Google private key format: OK");
  } catch (error) {
    throw new Error(
      "Google private key is invalid or incorrectly formatted. " +
      "Check GOOGLE_PRIVATE_KEY in Render Environment settings."
    );
  }
}

// Google Sheets authentication.
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

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;

// Philippine local timestamp.
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

  return `${values.year}-${values.month}-${values.day} ` +
    `${values.hour}:${values.minute}:${values.second}`;
}

// Attendance endpoint.
app.post("/api/attendance", async (req, res) => {
  try {
    const lrn = String(req.body?.lrn || "").trim();

    if (!/^\d{1,20}$/.test(lrn)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid numeric LRN."
      });
    }

    // Find the registered student.
    const studentResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Students'!A2:B1000"
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
        message: "Your student record is incomplete. Contact your teacher."
      });
    }

    const timestamp = getPhilippineTimestamp();

    // Record attendance in Google Sheets.
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
    // Log useful error details without printing credentials.
    console.error(
      "Attendance operation failed:",
      error.message,
      "Code:",
      error.code || "N/A",
      "HTTP status:",
      error.response?.status || "N/A"
    );

    return res.status(500).json({
      success: false,
      message: "Unable to record attendance right now. Please try again."
    });
  }
});

// Health check.
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Start the server only when configuration is valid.
try {
  checkConfiguration();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`QR Attendance server running on port ${PORT}`);
  });
} catch (error) {
  console.error("Startup error:", error.message);
  process.exit(1);
}
