require("dotenv").config();

const QRCode = require("qrcode");
const path = require("path");

async function generateQR() {
  const websiteURL = process.env.BASE_URL;

  if (!websiteURL) {
    throw new Error("Please set BASE_URL in your .env file.");
  }

  const parsedURL = new URL(websiteURL);

  if (
    parsedURL.protocol !== "https:" &&
    parsedURL.hostname !== "localhost" &&
    parsedURL.hostname !== "127.0.0.1"
  ) {
    throw new Error("Use HTTPS for a public attendance website.");
  }

  const outputPath = path.join(
    __dirname,
    "..",
    "public",
    "attendance-qr.png"
  );

  await QRCode.toFile(outputPath, websiteURL, {
    width: 500,
    margin: 3,
    errorCorrectionLevel: "H"
  });

  console.log("QR code generated successfully!");
  console.log(`Website: ${websiteURL}`);
  console.log(`Image: ${outputPath}`);
}

generateQR().catch(error => {
  console.error("QR generation failed:", error.message);
  process.exit(1);
});