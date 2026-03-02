// ── Feature Toggles (shared across pages) ─────────────────────────────
(function () {
  const bridge = window.recallBridge;
  if (!bridge) return;

  const sdkSwitch = document.getElementById("toggle-sdk");
  const botSwitch = document.getElementById("toggle-bot");
  const sdkWrap = document.getElementById("toggle-sdk-wrap");
  const botWrap = document.getElementById("toggle-bot-wrap");

  if (!sdkSwitch || !botSwitch) return;

  function applyState(toggles) {
    sdkSwitch.classList.toggle("on", toggles.desktopSdk);
    botSwitch.classList.toggle("on", toggles.botFleet);
    sdkWrap.classList.toggle("on", toggles.desktopSdk);
    botWrap.classList.toggle("on", toggles.botFleet);
  }

  // Load initial state
  bridge.getToggles().then(applyState);

  // Listen for state changes from main process
  bridge.onToggleState(applyState);

  // Click handlers
  sdkSwitch.addEventListener("click", async () => {
    const current = sdkSwitch.classList.contains("on");
    const newState = !current;

    if (current && !newState) {
      // Disabling — confirm
      if (!confirm("Disable Desktop SDK?\n\nThis will stop any active local recording.")) return;
    }

    const toggles = await bridge.setToggle("desktopSdk", newState);
    applyState(toggles);
  });

  botSwitch.addEventListener("click", async () => {
    const current = botSwitch.classList.contains("on");
    const newState = !current;

    if (current && !newState) {
      // Disabling — confirm and warn about force removal
      if (!confirm("Disable Bot Fleet?\n\nThis will FORCE REMOVE all active bots from any call. You will not be billed further.")) return;
    }

    const toggles = await bridge.setToggle("botFleet", newState);
    applyState(toggles);
  });
})();
