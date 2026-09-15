const form = document.querySelector("#resetForm");
const message = document.querySelector("#msg");
form.token.value = new URLSearchParams(location.search).get("token") || "";
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const response = await fetch("/api/password/reset", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-NoteVerse-Request": "1" },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Password reset failed.");
    form.reset();
    message.style.color = "var(--success)";
    message.textContent = "Password reset. You can now sign in.";
  } catch (error) {
    message.textContent = error.message;
  }
});
