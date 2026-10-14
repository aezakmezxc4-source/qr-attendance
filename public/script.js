const form = document.getElementById("attendanceForm");
const lrnInput = document.getElementById("lrn");
const submitButton = document.getElementById("submitButton");
const result = document.getElementById("result");

function showMessage(message, type) {
  result.className = `result ${type}`;
  result.textContent = message;
  result.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const lrn = lrnInput.value.trim();

  if (!/^\d{1,20}$/.test(lrn)) {
    showMessage("Please enter a valid numeric LRN.", "error");
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Recording...";
  result.hidden = true;

  try {
    const response = await fetch("/api/attendance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ lrn })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      showMessage(
        data.message || "Attendance could not be recorded.",
        "error"
      );
      return;
    }

    showMessage(
      `Welcome, ${data.studentName}!\n` +
      `Attendance recorded at ${data.timestamp}.\n` +
      `You may submit again if you scan another time.`,
      "success"
    );

    // Clear the input so it is ready for another submission.
    lrnInput.value = "";

  } catch (error) {
    showMessage(
      "Connection error. Please check your internet and try again.",
      "error"
    );
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Record Attendance";
  }
});