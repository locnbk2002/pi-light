"use strict";
const api = chrome;
const statusElement = document.getElementById("status");
async function message(payload) {
  try {
    const response = await api.runtime.sendMessage(payload);
    if (!response || response.error || typeof response.status !== "string") throw new Error("Operation rejected");
    statusElement.textContent = `${response.paired ? "Paired" : "Not paired"}, ${response.enabled ? "enabled" : "disabled"}. ${response.status}`;
  } catch { statusElement.textContent = "Operation failed; reload the add-on and retry."; }
}
document.getElementById("pairing").addEventListener("submit", event => {
  event.preventDefault();
  const secretElement = document.getElementById("secret");
  const secret = secretElement.value.trim();
  secretElement.value = "";
  void message({ type: "pair", secret });
});
document.getElementById("enable").addEventListener("click", () => { void message({ type: "enable" }); });
document.getElementById("disable").addEventListener("click", () => { void message({ type: "disable" }); });
document.getElementById("refresh").addEventListener("click", () => { void message({ type: "status" }); });
void message({ type: "status" });
