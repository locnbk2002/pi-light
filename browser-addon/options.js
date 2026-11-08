"use strict";
const api = chrome;
const statusElement = document.getElementById("status");
async function message(payload) {
  try {
    const response = await api.runtime.sendMessage(payload);
    if (!response || response.error || typeof response.status !== "string") throw new Error("Operation rejected");
    statusElement.textContent = response.status;
  } catch { statusElement.textContent = "Connection operation failed. Check local Pi, URL and session token; then retry."; }
}
document.getElementById("connection").addEventListener("submit", event => {
  event.preventDefault();
  const tokenElement = document.getElementById("token");
  const token = tokenElement.value;
  tokenElement.value = "";
  void message({ type: "connect", url: document.getElementById("url").value.trim(), token });
});
document.getElementById("disconnect").addEventListener("click", () => { void message({ type: "disconnect" }); });
document.getElementById("refresh").addEventListener("click", () => { void message({ type: "status" }); });
void message({ type: "status" });
