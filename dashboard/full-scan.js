/* Remote scans run in GitHub Actions. Closing this monitor never cancels a job. */
(() => {
  const key = "hypurrscan:full-scan-run:v1";
  const byId = (id) => document.getElementById(`scan-demo-${id}`);
  const dialog = byId("dialog");
  const strip = byId("strip");
  let enabled = false;
  let busy = false;
  let statusFlight = null;
  let payload = null;
  let reference = null;
  let error = "";
  let opener = null;
  let showingResult = false;

  const finished = () => payload?.run?.status === "completed";
  const active = () => Boolean(payload?.pending || (payload?.run && !finished()));
  const unacknowledged = () => payload?.pending && reference?.requestedAt && Date.now() - Date.parse(reference.requestedAt) > 180_000;
  const succeeded = () => finished() && payload.run.conclusion === "success" && payload.progress?.status === "success";
  const buttonLabel = () => busy ? "Full Scan · Connecting" : active() ? "Full Scan · Running" : payload?.run ? "Full Scan · Result" : "Full Scan";
  function remember() {
    if (payload?.run || payload?.requestId) {
      reference = { runId: payload.run?.id || null, requestId: payload.requestId || null,
        requestedAt: payload.requestedAt || reference?.requestedAt || new Date().toISOString() };
      try { sessionStorage.setItem(key, JSON.stringify(reference)); } catch { /* Job discovery also works without browser storage. */ }
    }
  }
  function render() {
    if (!enabled) return;
    els.refreshButton.textContent = buttonLabel();
    const done = finished();
    const progress = payload?.progress;
    const stages = progress?.stages || {};
    const completed = Object.values(stages).filter((stage) => stage.status === "completed").length;
    const phase = error ? "Unable to update progress" : busy ? "Connecting to GitHub Actions" : payload?.phase || "Ready to start";
    strip.classList.toggle("is-running", active());
    byId("strip-message").textContent = error || (active() ? `${phase} · scan continues in the background` : done ? "Scan workflow finished · review the result" : "Full Scan · Perps, Spot and Limit orders · scheduled runs stay active");
    byId("strip-open").textContent = active() ? "View progress ↗" : done ? "View result ↗" : "Start scan ↗";
    dialog.classList.toggle("is-complete", succeeded());
    byId("title").textContent = error ? "Scan connection issue" : succeeded() ? "Full scan complete" : done ? "Scan workflow finished" : "Full scan in progress";
    byId("run-id").textContent = payload?.run ? `GitHub run #${payload.run.id} · ${new Date(payload.run.startedAt).toLocaleString()}` : payload?.pending ? "Request sent · waiting for runner" : "Full scan / GitHub Actions";
    byId("stage").textContent = phase;
    byId("percent").textContent = `${completed}/3`;
    if (progress) byId("progress").value = completed / 3 * 100;
    else byId("progress").removeAttribute("value");
    byId("stage-detail").textContent = error || (unacknowledged() ? "GitHub has not confirmed this request yet. You can check again or explicitly retry; any active scan will be reused."
      : progress ? `${completed} of 3 scan stages completed. Stages run in parallel.` : "Live job status. Detailed stage progress appears when the scan worker starts.");
    const started = Date.parse(payload?.run?.startedAt || "");
    const elapsed = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 60_000)) : 0;
    byId("elapsed").textContent = Number.isFinite(started) ? `Started ${elapsed} min ago` : "Waiting for start";
    byId("remaining").textContent = done ? "Finished" : "No fixed ETA";
    byId("art-caption").textContent = done ? "The scan worker has finished." : "A little company while you wait.";
    byId("live-note").replaceChildren();
    const note = document.createElement("span");
    note.textContent = error ? "Checking status does not start another scan. " : done ? `GitHub result: ${payload.run.conclusion || "unknown"}. ` : "You can close this window. The scan keeps running. ";
    byId("live-note").append(note);
    if (payload?.run?.url) {
      const link = document.createElement("a");
      link.href = payload.run.url; link.textContent = "Open run logs ↗"; link.target = "_blank"; link.rel = "noopener noreferrer";
      byId("live-note").append(link);
    }
    for (const [index, id] of ["perps", "spot", "orders"].entries()) {
      const element = dialog.querySelector(`[data-demo-stage="${id}"]`);
      const stage = stages[id];
      element.classList.toggle("is-active", stage?.status === "running");
      element.classList.toggle("is-done", stage?.status === "completed");
      element.classList.toggle("is-failed", stage?.status === "failed" || stage?.status === "partial");
      if (stage?.status === "running") element.setAttribute("aria-current", "step"); else element.removeAttribute("aria-current");
      element.querySelector(".scan-demo-stage-number").textContent = stage?.status === "completed" ? "✓" : String(index + 1).padStart(2, "0");
      element.querySelector(".scan-demo-stage-count").textContent = stage?.status === "completed"
        ? `${stage.wallets || 0} wallets · done` : stage?.status === "failed" || stage?.status === "partial" ? "Needs attention" : stage?.status === "running" ? "Running" : done ? "See run logs" : "Waiting";
    }
    byId("result").hidden = !done || !showingResult;
    byId("result").querySelector(".section-index").textContent = succeeded() ? "FULL SCAN / RESULT" : "WORKFLOW / RESULT";
    byId("result").querySelector("h3").textContent = succeeded() ? "All three stages completed" : "Review the scan outcome";
    byId("result").querySelector("p").textContent = succeeded()
      ? `Snapshot #${progress.snapshotId} is ready. ${progress.reusedRunId ? "A scan completed while this request waited, so its result was reused. " : ""}Your selected snapshot stays open until you choose the new one.`
      : progress?.errors?.join(" · ") || "Detailed results are available in the run logs. Incomplete scans do not replace successful snapshots.";
    byId("replay").hidden = !done && !error && !unacknowledged();
    byId("replay").disabled = busy;
    byId("replay").textContent = error ? "Check status" : unacknowledged() ? "Retry request" : "Start new scan";
    byId("action").textContent = done && !showingResult ? "View result" : succeeded() && showingResult && progress.snapshotId ? "View new snapshot" : "Browse snapshots";
    byId("browse-note").textContent = "Closing this window does not cancel the scan. Full Scan reopens the same job.";
  }
  function refreshStatus() {
    if (statusFlight) return statusFlight;
    const params = new URLSearchParams();
    if (reference?.runId) params.set("runId", reference.runId);
    else if (reference?.requestId) params.set("requestId", reference.requestId);
    statusFlight = fetchJson(`/api/full-scan/status?${params}`).then((result) => {
      payload = result; error = ""; remember(); return result;
    }).catch((cause) => { error = cause.message || String(cause); throw cause; }).finally(() => { statusFlight = null; render(); });
    return statusFlight;
  }
  async function start() {
    if (busy || active()) return;
    busy = true; error = ""; showingResult = false; render();
    try {
      payload = await fetchJson("/api/full-scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      remember();
    } catch (cause) {
      error = `${cause.message || cause} Check status before trying again; the scan may already have been accepted.`;
    } finally { busy = false; render(); }
  }
  async function open() {
    if (!enabled || !state.fullScanRemote) return;
    opener = document.activeElement;
    byId("gif").src ||= "/dashboard/assets/social-find-waiting.gif";
    if (!dialog.open) dialog.showModal();
    render();
    if (busy) return;
    try {
      await refreshStatus();
      // Starting requires an explicit click. Recovery and polling are GET only.
      if (!payload?.run && !payload?.pending && !reference) await start();
    } catch { /* Keep the visible error and let the user check status. */ }
  }
  function enable() {
    if (enabled || !state.fullScanRemote) return;
    enabled = true; strip.hidden = false;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || "null");
      if (/^\d+$/.test(saved?.runId || "") || /^[a-f0-9-]{36}$/i.test(saved?.requestId || "")) reference = saved;
    } catch { /* Discover a currently active run instead. */ }
    strip.querySelector(".scan-demo-badge").textContent = "SCAN";
    dialog.querySelector(".scan-demo-badge").textContent = "LIVE JOB";
    byId("disclaimer").textContent = "Runs a real scan in GitHub Actions and saves its results. You can browse earlier snapshots while it runs.";
    byId("progress").setAttribute("aria-label", "Completed full scan stages");
    dialog.querySelector(".scan-demo-stages").setAttribute("aria-label", "Full scan stages");
    byId("replay").addEventListener("click", async () => {
      if (error) { try { await refreshStatus(); } catch {} return; }
      if ((!finished() && !unacknowledged()) || busy) return;
      payload = null; reference = null;
      try { sessionStorage.removeItem(key); } catch {}
      await start();
    });
    byId("action").addEventListener("click", async () => {
      if (finished() && !showingResult) { showingResult = true; render(); byId("result").scrollIntoView({ block: "nearest" }); return; }
      if (succeeded() && showingResult && payload.progress.snapshotId) {
        byId("action").disabled = true;
        try {
          if (isOrderView()) {
            state.market = "crypto"; setOrderControls(false);
            for (const tab of els.marketTabs) { tab.classList.toggle("is-active", tab.dataset.market === "crypto"); tab.setAttribute("aria-pressed", String(tab.dataset.market === "crypto")); }
          }
          await loadSnapshots(payload.progress.snapshotId); await loadSnapshotRows(); dialog.close();
        } catch (cause) { error = cause.message || String(cause); render(); }
        finally { byId("action").disabled = false; }
      } else dialog.close();
    });
    byId("strip-open").addEventListener("click", () => { void open(); });
    dialog.addEventListener("close", () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); });
    render();
    void refreshStatus().catch(() => {});
    setInterval(() => { if (!busy && (active() || (error && reference))) void refreshStatus().catch(() => {}); }, 15_000);
  }
  window.scanMonitor = { enable, open, buttonLabel };
  if (state.fullScanRemote) enable();
})();
