const els = {
  heroMeta: document.getElementById("hero-meta"),
  refreshButton: document.getElementById("refresh-button"),
  logoutButton: document.getElementById("logout-button"),
  snapshotSelect: document.getElementById("snapshot-select"),
  marketTabs: Array.from(document.querySelectorAll("[data-market]")),
  sortButtons: Array.from(document.querySelectorAll("[data-sort-key]")),
  summaryStatus: document.getElementById("summary-status"),
  summaryTraders: document.getElementById("summary-traders"),
  summaryPositions: document.getElementById("summary-positions"),
  tableTitle: document.getElementById("table-title"),
  tableSubtitle: document.getElementById("table-subtitle"),
  tableStatus: document.getElementById("table-status"),
  tableBody: document.getElementById("table-body"),
  statusBanner: document.getElementById("status-banner"),
};

const state = {
  market: "crypto",
  snapshots: [],
  selectedSnapshotId: null,
  rows: [],
  openToken: null,
  drilldowns: new Map(),
  refreshPollId: null,
  refreshRunning: false,
  sortKey: "smwFlows",
  sortDir: "desc",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtUsd(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return "$0.00";
  return numeric.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function fmtDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("Authentication required");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

function setBanner(message, tone = "warning") {
  if (!message) {
    els.statusBanner.hidden = true;
    els.statusBanner.textContent = "";
    return;
  }
  els.statusBanner.hidden = false;
  els.statusBanner.textContent = message;
  els.statusBanner.dataset.tone = tone;
}

function updateSummary(snapshot) {
  const status = snapshot?.status || "idle";
  els.summaryStatus.textContent = status.toUpperCase();
  els.summaryStatus.className = "pill";
  if (status === "success") els.summaryStatus.classList.add("is-success");
  if (status === "partial" || status === "running") els.summaryStatus.classList.add("is-warning");
  if (status === "failed") els.summaryStatus.classList.add("is-danger");

  els.summaryTraders.textContent = `${Number(snapshot?.traders_completed || 0)}/${Number(snapshot?.total_traders || 0)} traders`;
  els.summaryPositions.textContent = `${Number(snapshot?.total_positions || 0)} positions`;

  if (!snapshot) {
    els.heroMeta.textContent = "No signal snapshot yet. Trigger a manual refresh to gather positions.";
    return;
  }

  const timestamp = snapshot.finished_at || snapshot.created_at;
  const suffix =
    status === "running"
      ? "Refresh in progress"
      : status === "partial"
        ? `${Number(snapshot.traders_failed || 0)} trader scrapes failed`
        : status === "failed"
          ? snapshot.error_message || "Refresh failed"
          : "Ready";
  els.heroMeta.textContent = `${fmtDate(timestamp)} · ${suffix}`;
}

function renderSnapshotOptions() {
  els.snapshotSelect.innerHTML = state.snapshots
    .map(
      (snapshot) => `
        <option value="${snapshot.id}" ${snapshot.id === state.selectedSnapshotId ? "selected" : ""}>
          #${snapshot.id} · ${fmtDate(snapshot.finished_at || snapshot.created_at)} · ${snapshot.status}
        </option>
      `,
    )
    .join("");
}

function metricClass(value) {
  if (value > 0) return "metric-text-positive";
  if (value < 0) return "metric-text-negative";
  return "";
}

function maxMetric(rows, key) {
  return Math.max(...rows.map((row) => Math.abs(Number(row[key] || 0))), 1);
}

function compareTokens(left, right) {
  return String(left?.token || "").localeCompare(String(right?.token || ""), undefined, {
    sensitivity: "base",
  });
}

function compareNumbers(left, right, key) {
  return Number(left?.[key] || 0) - Number(right?.[key] || 0);
}

function getSortedRows(rows) {
  const direction = state.sortDir === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const primary = compareNumbers(left, right, state.sortKey);
    if (primary !== 0) return primary * direction;

    const holdingsFallback = compareNumbers(left, right, "holdingsUsd");
    if (holdingsFallback !== 0) return holdingsFallback * -1;

    const flowsFallback = compareNumbers(left, right, "smwFlows");
    if (flowsFallback !== 0) return flowsFallback * -1;

    return compareTokens(left, right);
  });
}

function describeSort() {
  const labels = {
    smwFlows: "SMW Flows",
    holdingsUsd: "Holdings",
    longSmw: "Long SMW",
    shortSmw: "Short SMW",
  };
  const direction = state.sortDir === "asc" ? "ascending" : "descending";
  return `${labels[state.sortKey]} ${direction}`;
}

function updateSortButtons() {
  for (const button of els.sortButtons) {
    const isActive = button.dataset.sortKey === state.sortKey;
    button.classList.toggle("is-active", isActive);
    button.setAttribute(
      "aria-sort",
      isActive ? (state.sortDir === "asc" ? "ascending" : "descending") : "none",
    );

    const indicator = button.querySelector(".sort-indicator");
    if (!indicator) continue;
    indicator.textContent = isActive ? (state.sortDir === "asc" ? "↑" : "↓") : "-";
  }
}

function buildDrilldownCell(token) {
  const cached = state.drilldowns.get(token);
  if (!cached) {
    return `
      <div class="drilldown-panel">
        <div class="empty-note">Loading trader breakdown...</div>
      </div>
    `;
  }

  const buildItems = (rows) =>
    rows.length
      ? rows
          .map(
            (row) => `
              <div class="drilldown-item">
                <span>${escapeHtml(row.traderName)}</span>
                <span>${escapeHtml(fmtUsd(row.valueUsd))}</span>
              </div>
            `,
          )
          .join("")
      : '<div class="empty-note">No traders on this side.</div>';

  return `
    <div class="drilldown-panel">
      <div class="drilldown-grid">
        <section class="drilldown-card">
          <h3>Long</h3>
          <div class="drilldown-list">${buildItems(cached.longRows || [])}</div>
        </section>
        <section class="drilldown-card">
          <h3>Short</h3>
          <div class="drilldown-list">${buildItems(cached.shortRows || [])}</div>
        </section>
      </div>
    </div>
  `;
}

function renderTable() {
  const rows = Array.isArray(state.rows) ? getSortedRows(state.rows) : [];
  els.tableTitle.textContent = state.market === "crypto" ? "Crypto" : "TradFi";
  els.tableSubtitle.textContent = `Snapshot #${state.selectedSnapshotId || "—"} token-level signals sorted by ${describeSort()}.`;
  els.tableStatus.textContent = `${rows.length} rows`;
  updateSortButtons();

  if (!rows.length) {
    els.tableBody.innerHTML = `
      <tr>
        <td colspan="5">
          <div class="drilldown-panel">
            <div class="empty-note">No token signals available for this market and snapshot.</div>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  const maxFlows = maxMetric(rows, "smwFlows");
  const maxHoldings = maxMetric(rows, "holdingsUsd");
  const maxLong = maxMetric(rows, "longSmw");
  const maxShort = maxMetric(rows, "shortSmw");

  els.tableBody.innerHTML = rows
    .map((row) => {
      const token = String(row.token || "");
      const isOpen = state.openToken === token;
      return `
        <tr class="signal-row ${isOpen ? "is-open" : ""}" data-token="${escapeHtml(token)}">
          <td>
            <div class="token-cell">
              <div class="token-badge">${escapeHtml(token.slice(0, 2).toUpperCase() || "?")}</div>
              <div class="token-text">
                <div class="token-name">${escapeHtml(token)}</div>
                <div class="token-sub">Click to view long and short traders</div>
              </div>
            </div>
          </td>
          <td>
            <div class="metric-value ${row.smwFlows < 0 ? "metric-value--negative" : ""}" style="--fill:${(Math.abs(row.smwFlows) / maxFlows) * 100}%">
              <span class="${metricClass(row.smwFlows)}">${escapeHtml(String(row.smwFlows))}</span>
            </div>
          </td>
          <td>
            <div class="metric-value" style="--fill:${(Number(row.holdingsUsd || 0) / maxHoldings) * 100}%">
              <span>${escapeHtml(fmtUsd(row.holdingsUsd))}</span>
            </div>
          </td>
          <td>
            <div class="metric-value" style="--fill:${(Number(row.longSmw || 0) / maxLong) * 100}%">
              <span>${escapeHtml(String(row.longSmw))}</span>
            </div>
          </td>
          <td>
            <div class="metric-value metric-value--negative" style="--fill:${(Number(row.shortSmw || 0) / maxShort) * 100}%">
              <span>${escapeHtml(String(row.shortSmw))}</span>
            </div>
          </td>
        </tr>
        ${
          isOpen
            ? `<tr class="drilldown-row"><td colspan="5">${buildDrilldownCell(token)}</td></tr>`
            : ""
        }
      `;
    })
    .join("");
}

async function loadSnapshots(preferredSnapshotId) {
  const payload = await fetchJson("/api/signals/snapshots");
  state.snapshots = Array.isArray(payload.snapshots) ? payload.snapshots : [];
  if (!state.snapshots.length) {
    state.selectedSnapshotId = null;
    renderSnapshotOptions();
    return null;
  }

  const nextId =
    preferredSnapshotId ||
    state.selectedSnapshotId ||
    Number(state.snapshots[0].id);

  state.selectedSnapshotId = state.snapshots.some((snapshot) => snapshot.id === Number(nextId))
    ? Number(nextId)
    : Number(state.snapshots[0].id);
  renderSnapshotOptions();
  return state.snapshots.find((snapshot) => snapshot.id === state.selectedSnapshotId) || null;
}

async function loadSnapshotRows() {
  if (!state.selectedSnapshotId) {
    state.rows = [];
    updateSummary(null);
    renderTable();
    return;
  }

  const payload = await fetchJson(`/api/signals/${state.selectedSnapshotId}?market=${state.market}`);
  state.rows = Array.isArray(payload.rows) ? payload.rows : [];
  state.openToken = null;
  updateSummary(payload.snapshot || null);
  renderTable();
}

async function loadInitialData() {
  const latest = await loadSnapshots();
  updateSummary(latest);
  await loadSnapshotRows();
  if (latest?.status === "running" && state.selectedSnapshotId) {
    void pollRefresh(state.selectedSnapshotId);
  }
}

async function ensureDrilldown(token) {
  if (!state.selectedSnapshotId || state.drilldowns.has(token)) return;
  const payload = await fetchJson(
    `/api/signals/${state.selectedSnapshotId}/token/${encodeURIComponent(token)}`,
  );
  state.drilldowns.set(token, payload);
  renderTable();
}

async function pollRefresh(snapshotId) {
  state.refreshRunning = true;
  els.refreshButton.disabled = true;
  state.refreshPollId = snapshotId;

  while (state.refreshPollId === snapshotId) {
    const payload = await fetchJson(`/api/signals/refresh/${snapshotId}/status`);
    updateSummary(payload.snapshot || null);

    const runtime = payload.runtime || {};
    if (runtime.canContinue) {
      setBanner("Refresh running. Continuing the next trader batch...", "warning");
      await fetchJson(`/api/signals/refresh/${snapshotId}/continue`, { method: "POST" });
      await loadSnapshots(snapshotId);
      await loadSnapshotRows();
      continue;
    }

    if (runtime.running || payload.snapshot?.status === "running") {
      const runs = Array.isArray(payload.runs) ? payload.runs : [];
      const failed = runs.filter((run) => run.status === "failed");
      if (failed.length) {
        setBanner(`Refresh running. ${failed.length} trader scrapes have failed so far.`, "warning");
      } else {
        setBanner("Refresh running. Gathering trader positions from Hypurrscan...", "warning");
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
      continue;
    }

    setBanner(
      payload.snapshot?.status === "partial"
        ? "Refresh finished with partial failures. Snapshot was still saved."
        : payload.snapshot?.status === "failed"
          ? payload.snapshot?.error_message || "Refresh failed."
          : "Refresh complete.",
      payload.snapshot?.status === "failed" ? "danger" : payload.snapshot?.status === "partial" ? "warning" : "success",
    );

    state.refreshPollId = null;
    state.refreshRunning = false;
    els.refreshButton.disabled = false;
    await loadSnapshots(snapshotId);
    await loadSnapshotRows();
    return;
  }
}

els.refreshButton.addEventListener("click", async () => {
  try {
    setBanner("");
    const payload = await fetchJson("/api/signals/refresh", { method: "POST" });
    await loadSnapshots(payload.snapshotId);
    await loadSnapshotRows();
    void pollRefresh(payload.snapshotId);
  } catch (error) {
    setBanner((error && error.message) || String(error), "danger");
  }
});

els.logoutButton.addEventListener("click", async () => {
  await fetchJson("/api/auth/logout", { method: "POST" });
  window.location.href = "/login";
});

els.snapshotSelect.addEventListener("change", async (event) => {
  state.selectedSnapshotId = Number(event.target.value || 0) || null;
  state.drilldowns.clear();
  await loadSnapshotRows();
});

for (const button of els.sortButtons) {
  button.addEventListener("click", () => {
    const nextKey = button.dataset.sortKey;
    if (!nextKey) return;
    if (state.sortKey === nextKey) {
      state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
    } else {
      state.sortKey = nextKey;
      state.sortDir = "desc";
    }
    renderTable();
  });
}

for (const button of els.marketTabs) {
  button.addEventListener("click", async () => {
    state.market = button.dataset.market === "tradfi" ? "tradfi" : "crypto";
    state.drilldowns.clear();
    for (const candidate of els.marketTabs) {
      candidate.classList.toggle("is-active", candidate === button);
    }
    await loadSnapshotRows();
  });
}

els.tableBody.addEventListener("click", async (event) => {
  const row = event.target.closest(".signal-row");
  if (!row) return;
  const token = row.dataset.token;
  if (!token) return;
  state.openToken = state.openToken === token ? null : token;
  renderTable();
  if (state.openToken === token) {
    await ensureDrilldown(token);
  }
});

void loadInitialData().catch((error) => {
  setBanner((error && error.message) || String(error), "danger");
});
