/* Browser-only simulation for hosted dashboards and local previews. Never starts a real scan. */
(() => {
  const storageKey = "hypurrscan:full-scan-demo:v1";
  const durationMs = 48_000;
  const stages = [
    { id: "perps", label: "Perps · Crypto + TradFi", from: 0, to: 18_000 },
    { id: "spot", label: "Spot holdings", from: 18_000, to: 31_000 },
    { id: "orders", label: "Limit orders", from: 31_000, to: 43_000 },
  ];
  const dialog = document.getElementById("scan-demo-dialog");
  const strip = document.getElementById("scan-demo-strip");
  const byId = (id) => document.getElementById(`scan-demo-${id}`);
  let enabled = false;
  let job = null;
  let showingResult = false;
  let ticker = null;
  let opener = null;

  function elapsed() { return job ? Math.max(0, Math.min(durationMs, Date.now() - job.startedAt)) : 0; }
  function complete() { return Boolean(job) && elapsed() >= durationMs; }
  function clock(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }
  function save() {
    try { sessionStorage.setItem(storageKey, JSON.stringify(job)); } catch { /* In-memory demo still works. */ }
  }
  function restore() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      if (saved && Number.isFinite(saved.startedAt) && saved.startedAt > 0 && saved.startedAt <= Date.now()
          && Number.isInteger(saved.wallets) && saved.wallets > 0 && saved.wallets <= 10_000) job = saved;
    } catch { /* An unavailable or invalid saved demo starts idle. */ }
  }
  function buttonLabel() {
    return !job ? "Full Scan" : complete() ? "Full Scan · Result" : "Full Scan · Running";
  }
  function startDemo() {
    const snapshot = state.snapshots.find((row) => row.id === state.selectedSnapshotId);
    job = { startedAt: Date.now(), wallets: Math.max(1, Math.min(10_000, Math.floor(Number(snapshot?.total_traders) || 106))) };
    showingResult = false;
    save();
    if (!ticker) ticker = setInterval(render, 1000);
    render();
  }
  function render() {
    if (!enabled) return;
    const ms = elapsed();
    const done = complete();
    const current = stages.find((stage) => ms < stage.to);
    const percent = job ? Math.floor(ms / durationMs * 100) : 0;
    const label = current?.label || "Preparing demo result";
    els.refreshButton.textContent = buttonLabel();
    els.refreshButton.disabled = false;
    strip.classList.toggle("is-running", Boolean(job) && !done);
    byId("strip-message").textContent = !job
      ? "Try Full Scan · 48-second simulation · no real scan"
      : done ? "Demo complete · your saved snapshots are unchanged" : `${label} · ${percent}% · simulated progress`;
    byId("strip-open").textContent = !job ? "Try demo ↗" : done ? "See demo result ↗" : "View progress ↗";
    if (!job) return;

    dialog.classList.toggle("is-complete", done);
    byId("title").textContent = showingResult ? "Demo scan result" : done ? "Demo scan complete" : "Full scan in progress";
    byId("run-id").textContent = `Demo run · ${new Date(job.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${job.wallets} wallets`;
    byId("percent").textContent = `${percent}%`;
    byId("progress").value = percent;
    byId("stage").textContent = done ? "Ready to review" : label;
    byId("stage-detail").textContent = current
      ? `${Math.floor(Math.min(1, Math.max(0, (ms - current.from) / (current.to - current.from))) * job.wallets)} / ${job.wallets} wallets · simulated`
      : done ? "Perps, Spot and Limit orders completed in the demo." : "Checking simulated coverage and preparing the result…";
    byId("elapsed").textContent = `Elapsed ${clock(ms)}`;
    byId("remaining").textContent = done ? "Finished" : `Demo ends in ${clock(durationMs - ms)}`;
    byId("live-note").textContent = done
      ? "No real scan ran. No new snapshot was written."
      : "The demo keeps progressing when this window is closed.";
    byId("art-caption").textContent = done ? "All done. That was just a rehearsal." : "A little company while you wait.";

    for (const stage of stages) {
      const element = dialog.querySelector(`[data-demo-stage="${stage.id}"]`);
      const finished = ms >= stage.to;
      const active = ms >= stage.from && ms < stage.to;
      element.classList.toggle("is-active", active);
      element.classList.toggle("is-done", finished);
      if (active) element.setAttribute("aria-current", "step"); else element.removeAttribute("aria-current");
      element.querySelector(".scan-demo-stage-number").textContent = finished ? "✓" : String(stages.indexOf(stage) + 1).padStart(2, "0");
      const count = Math.floor(Math.min(1, Math.max(0, (ms - stage.from) / (stage.to - stage.from))) * job.wallets);
      element.querySelector(".scan-demo-stage-count").textContent = finished ? `${job.wallets}/${job.wallets} · done` : active ? `${count}/${job.wallets} wallets` : "Queued";
    }
    byId("result").hidden = !showingResult;
    byId("replay").hidden = !done;
    byId("action").textContent = done && !showingResult ? "View demo result" : "Browse snapshots";
    byId("browse-note").textContent = done
      ? "Your selected snapshot stays open. You can review this demo or replay it."
      : "Close this window to browse older snapshots. Full Scan reopens the same progress.";
    if (done && ticker) { clearInterval(ticker); ticker = null; }
  }
  function open() {
    if (!enabled || !state.scanDemo) return;
    opener = document.activeElement;
    if (!job) startDemo();
    byId("gif").src ||= "/dashboard/assets/social-find-waiting.gif";
    render();
    if (!dialog.open) dialog.showModal();
  }
  function close() { dialog.close(); }
  function enable() {
    if (enabled || !state.scanDemo) return;
    enabled = true;
    strip.hidden = false;
    restore();
    if (job && !complete()) ticker = setInterval(render, 1000);
    render();
  }

  byId("close").addEventListener("click", close);
  byId("strip-open").addEventListener("click", open);
  byId("replay").addEventListener("click", () => { if (enabled) startDemo(); });
  byId("action").addEventListener("click", () => {
    if (!enabled) return;
    if (complete() && !showingResult) {
      showingResult = true;
      render();
      byId("result").scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else close();
  });
  dialog.addEventListener("close", () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  window.scanPreview = { enable, open, buttonLabel };
  // The health request may finish before or after this deferred script.
  if (state.scanDemo) enable();
})();
