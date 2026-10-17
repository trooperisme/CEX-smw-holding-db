const els = {
  heroMeta: document.getElementById("hero-meta"),
  refreshButton: document.getElementById("refresh-button"),
  logoutButton: document.getElementById("logout-button"),
  copyButton: document.getElementById("copy-button"),
  snapshotSelect: document.getElementById("snapshot-select"),
  marketTabs: Array.from(document.querySelectorAll("[data-market]")),
  tableHead: document.getElementById("table-head"),
  sortButtons: [],
  summaryStatus: document.getElementById("summary-status"),
  summaryTraders: document.getElementById("summary-traders"),
  summaryPositions: document.getElementById("summary-positions"),
  summaryZeroPositions: document.getElementById("summary-zero-positions"),
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
  runSummary: null,
  coverageSummary: null,
  spotSummary: null,
  spotGeneratedAt: null,
  copyRunning: false,
};

const MAX_VISIBLE_SNAPSHOTS = 5;

const perpsSortLabels = {
  smwFlows: "SMW Flows",
  holdingsUsd: "Holdings",
  longSmw: "Long SMW",
  shortSmw: "Short SMW",
};

const spotSortLabels = {
  holdersCount: "SMW Holders",
  totalValueUsd: "Total Value",
  topHolderValueUsd: "Top Holder",
};

function isSpotView() {
  return state.market === "spot";
}

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

function shortWallet(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (normalized.length <= 12) return normalized;
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
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

function buildCoverageBanner(coverageSummary) {
  const missingTrackedCount = Number(coverageSummary?.missingTrackedCount || 0);
  if (missingTrackedCount <= 0) return null;

  const missingPreview = Array.isArray(coverageSummary?.missingTrackedTraders)
    ? coverageSummary.missingTrackedTraders
        .slice(0, 3)
        .map((trader) => `${trader.traderName} (${shortWallet(trader.walletAddress)})`)
        .join(", ")
    : "";
  const suffix =
    missingTrackedCount > 3 ? `, plus ${missingTrackedCount - 3} more` : "";

  return `Snapshot is missing ${missingTrackedCount} tracked trader${missingTrackedCount === 1 ? "" : "s"} from the current CSV: ${missingPreview}${suffix}. Run refresh to include them.`;
}

function updateSummary(snapshot, runSummary = null) {
  const status = snapshot?.status || "idle";
  els.summaryStatus.textContent = status.toUpperCase();
  els.summaryStatus.className = "pill";
  if (status === "success") els.summaryStatus.classList.add("is-success");
  if (status === "partial" || status === "running") els.summaryStatus.classList.add("is-warning");
  if (status === "failed") els.summaryStatus.classList.add("is-danger");

  els.summaryTraders.textContent = `${Number(snapshot?.traders_completed || 0)}/${Number(snapshot?.total_traders || 0)} traders`;
  els.summaryPositions.textContent = `${Number(snapshot?.total_positions || 0)} positions`;
  els.summaryZeroPositions.textContent = `${Number(runSummary?.zeroPositionCount || 0)} zero-position traders`;

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

function updateSpotSummary(payload) {
  const summary = payload?.summary || {};
  const generatedAt = payload?.generatedAt || null;
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const status = generatedAt ? "ready" : "missing";
  const minUsd = Number(summary.minUsd || 333);

  els.summaryStatus.textContent = status.toUpperCase();
  els.summaryStatus.className = "pill";
  els.summaryStatus.classList.add(generatedAt ? "is-success" : "is-warning");
  els.summaryTraders.textContent = `${Number(summary.tradersScanned || 0)} traders`;
  els.summaryPositions.textContent = `${Number(summary.keptHoldings || summary.relevantHoldings || 0)} spot holdings > ${fmtUsd(minUsd)}`;
  els.summaryZeroPositions.textContent = `${rows.length} non-stable tokens`;

  els.heroMeta.textContent = generatedAt
    ? `${fmtDate(generatedAt)} · Spot holdings ready`
    : "No spot holdings export yet. Refresh Spot to generate the dataset.";
}

function updateCopyButton() {
  if (els.refreshButton) {
    els.refreshButton.textContent = state.refreshRunning
      ? "Refreshing..."
      : isSpotView()
        ? "Refresh Spot"
        : "Refresh Signals";
  }
  if (!els.copyButton) return;
  els.copyButton.disabled = isSpotView() || !state.selectedSnapshotId || state.copyRunning;
  els.copyButton.textContent = state.copyRunning ? "Copying..." : "Copy";
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
  const labels = isSpotView() ? spotSortLabels : perpsSortLabels;
  if (!Object.prototype.hasOwnProperty.call(labels, state.sortKey)) {
    state.sortKey = isSpotView() ? "holdersCount" : "smwFlows";
    state.sortDir = "desc";
  }

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
  const labels = isSpotView() ? spotSortLabels : perpsSortLabels;
  const direction = state.sortDir === "asc" ? "ascending" : "descending";
  return `${labels[state.sortKey]} ${direction}`;
}

function updateSortButtons() {
  els.sortButtons = Array.from(document.querySelectorAll("[data-sort-key]"));
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

function renderPerpsTableHead() {
  els.tableHead.innerHTML = `
    <tr>
      <th>Token</th>
      <th>
        <button class="sort-button" type="button" data-sort-key="smwFlows">
          <span>SMW Flows</span>
          <span class="sort-indicator" aria-hidden="true">-</span>
        </button>
      </th>
      <th>
        <button class="sort-button" type="button" data-sort-key="holdingsUsd">
          <span>Holdings</span>
          <span class="sort-indicator" aria-hidden="true">-</span>
        </button>
      </th>
      <th>
        <button class="sort-button" type="button" data-sort-key="longSmw">
          <span>Long SMW</span>
          <span class="sort-indicator" aria-hidden="true">-</span>
        </button>
      </th>
      <th>
        <button class="sort-button" type="button" data-sort-key="shortSmw">
          <span>Short SMW</span>
          <span class="sort-indicator" aria-hidden="true">-</span>
        </button>
      </th>
    </tr>
  `;
}

function renderSpotTableHead() {
  els.tableHead.innerHTML = `
    <tr>
      <th>Token</th>
      <th>
        <button class="sort-button" type="button" data-sort-key="holdersCount">
          <span>SMW Holders</span>
          <span class="sort-indicator" aria-hidden="true">-</span>
        </button>
      </th>
      <th>
        <button class="sort-button" type="button" data-sort-key="totalValueUsd">
          <span>Total Value</span>
          <span class="sort-indicator" aria-hidden="true">-</span>
        </button>
      </th>
      <th>
        <button class="sort-button" type="button" data-sort-key="topHolderValueUsd">
          <span>Top Holder</span>
          <span class="sort-indicator" aria-hidden="true">-</span>
        </button>
      </th>
    </tr>
  `;
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
                <span>${escapeHtml(row.traderName)} <span class="token-sub">${escapeHtml(shortWallet(row.walletAddress))}</span></span>
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

function buildSpotDrilldownCell(row) {
  const holders = Array.isArray(row?.holders) ? row.holders : [];
  const items = holders.length
    ? holders
        .map(
          (holder) => `
            <div class="drilldown-item">
              <span>
                ${escapeHtml(holder.traderName)}
                <span class="token-sub">${escapeHtml(shortWallet(holder.walletAddress))}</span>
              </span>
              <span>
                <a class="drilldown-link" href="${escapeHtml(holder.spotUrl)}" target="_blank" rel="noreferrer">
                  ${escapeHtml(fmtUsd(holder.valueUsd))}
                </a>
              </span>
            </div>
          `,
        )
        .join("")
    : '<div class="empty-note">No holders after token filtering.</div>';

  return `
    <div class="drilldown-panel">
      <div class="drilldown-card">
        <h3>${escapeHtml(row?.token || "Token")} spot holders</h3>
        <div class="drilldown-list">${items}</div>
      </div>
    </div>
  `;
}

function renderTable() {
  if (isSpotView()) {
    renderSpotTable();
    return;
  }

  renderPerpsTableHead();
  const rows = Array.isArray(state.rows) ? getSortedRows(state.rows) : [];
  els.tableTitle.textContent = state.market === "crypto" ? "Crypto" : "TradFi";
  const tradersWithPositionsCount = Number(state.runSummary?.tradersWithPositionsCount || 0);
  const zeroPositionCount = Number(state.runSummary?.zeroPositionCount || 0);
  els.tableSubtitle.textContent =
    `Snapshot #${state.selectedSnapshotId || "—"} token-level signals sorted by ${describeSort()}. ` +
    `${tradersWithPositionsCount} traders currently contribute rows; ${zeroPositionCount} scraped successfully with 0 open perps.`;
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

function renderSpotTable() {
  renderSpotTableHead();
  const rows = Array.isArray(state.rows) ? getSortedRows(state.rows) : [];
  const summary = state.spotSummary || {};
  const filteredOut = summary.filteredOut || {};
  const filteredCount =
    Number(filteredOut.stable || 0) +
    Number(filteredOut.trash || 0) +
    Number(filteredOut.unrelated || 0);
  const minUsd = Number(summary.minUsd || 333);

  els.tableTitle.textContent = "Spot";
  els.tableSubtitle.textContent =
    `Non-stable spot holdings > ${fmtUsd(minUsd)} sorted by ${describeSort()}. ` +
    `${Number(summary.keptHoldings || summary.relevantHoldings || 0)} holdings kept; ${filteredCount} stable/trash/unrelated holdings filtered.`;
  els.tableStatus.textContent = `${rows.length} rows`;
  updateSortButtons();

  if (!rows.length) {
    els.tableBody.innerHTML = `
      <tr>
        <td colspan="4">
          <div class="drilldown-panel">
            <div class="empty-note">No non-stable spot holdings > ${escapeHtml(fmtUsd(minUsd))} available. Refresh Spot to generate the dataset.</div>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  const maxHolders = maxMetric(rows, "holdersCount");
  const maxTotal = maxMetric(rows, "totalValueUsd");
  const maxTop = maxMetric(rows, "topHolderValueUsd");

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
                <div class="token-sub">Click to view spot holders</div>
              </div>
            </div>
          </td>
          <td>
            <div class="metric-value" style="--fill:${(Number(row.holdersCount || 0) / maxHolders) * 100}%">
              <span>${escapeHtml(String(row.holdersCount || 0))}</span>
            </div>
          </td>
          <td>
            <div class="metric-value" style="--fill:${(Number(row.totalValueUsd || 0) / maxTotal) * 100}%">
              <span>${escapeHtml(fmtUsd(row.totalValueUsd))}</span>
            </div>
          </td>
          <td>
            <div class="metric-value" style="--fill:${(Number(row.topHolderValueUsd || 0) / maxTop) * 100}%">
              <span>${escapeHtml(row.topHolderName || "-")} · ${escapeHtml(fmtUsd(row.topHolderValueUsd))}</span>
            </div>
          </td>
        </tr>
        ${
          isOpen
            ? `<tr class="drilldown-row"><td colspan="4">${buildSpotDrilldownCell(row)}</td></tr>`
            : ""
        }
      `;
    })
    .join("");
}

async function loadSnapshots(preferredSnapshotId) {
  const payload = await fetchJson("/api/signals/snapshots");
  state.snapshots = Array.isArray(payload.snapshots) ? payload.snapshots.slice(0, MAX_VISIBLE_SNAPSHOTS) : [];
  if (!state.snapshots.length) {
    state.selectedSnapshotId = null;
    renderSnapshotOptions();
    updateCopyButton();
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
  updateCopyButton();
  return state.snapshots.find((snapshot) => snapshot.id === state.selectedSnapshotId) || null;
}

async function loadSnapshotRows() {
  if (isSpotView()) {
    const payload = await fetchJson("/api/spot-holdings");
    state.rows = Array.isArray(payload.rows) ? payload.rows : [];
    state.spotSummary = payload.summary || null;
    state.spotGeneratedAt = payload.generatedAt || null;
    state.openToken = null;
    updateSpotSummary(payload);
    if (payload.generatedAt) {
      const filteredOut = payload.summary?.filteredOut || {};
      const minUsd = Number(payload.summary?.minUsd || 333);
      setBanner(
        `Spot filter kept ${Number(payload.summary?.keptHoldings || payload.summary?.relevantHoldings || 0)} non-stable holdings > ${fmtUsd(minUsd)}. Filtered out stable=${Number(filteredOut.stable || 0)}, trash=${Number(filteredOut.trash || 0)}, unrelated=${Number(filteredOut.unrelated || 0)}.`,
        "info",
      );
    } else {
      setBanner("No spot export found. Click Refresh Signals while Spot is selected to generate it.", "warning");
    }
    renderTable();
    updateCopyButton();
    return;
  }

  if (!state.selectedSnapshotId) {
    state.rows = [];
    updateSummary(null);
    renderTable();
    updateCopyButton();
    return;
  }

  const payload = await fetchJson(`/api/signals/${state.selectedSnapshotId}?market=${state.market}`);
  state.rows = Array.isArray(payload.rows) ? payload.rows : [];
  state.runSummary = payload.runSummary || null;
  state.coverageSummary = payload.coverageSummary || null;
  state.openToken = null;
  updateSummary(payload.snapshot || null, state.runSummary);
  if (!state.refreshRunning) {
    const coverageBanner = buildCoverageBanner(state.coverageSummary);
    const zeroPositionCount = Number(state.runSummary?.zeroPositionCount || 0);
    const failedCount = Number(state.runSummary?.failedCount || 0);
    if (coverageBanner) {
      setBanner(coverageBanner, "warning");
    } else if (failedCount > 0) {
      setBanner(`${failedCount} trader scrapes failed in this snapshot.`, "warning");
    } else if (zeroPositionCount > 0) {
      setBanner(
        `${zeroPositionCount} tracked traders had 0 open perps in this snapshot, so they do not appear in the token table.`,
        "info",
      );
    } else {
      setBanner("", "info");
    }
  }
  renderTable();
  updateCopyButton();
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function copySignalExport() {
  if (!state.selectedSnapshotId || state.copyRunning) return;
  state.copyRunning = true;
  updateCopyButton();
  try {
    const payload = await fetchJson(
      `/api/signals/${state.selectedSnapshotId}/export?market=${encodeURIComponent(state.market)}`,
    );
    await copyTextToClipboard(String(payload.text || ""));
    setBanner(`Copied ${state.market} snapshot #${state.selectedSnapshotId} data.`, "success");
  } catch (error) {
    setBanner((error && error.message) || String(error), "danger");
  } finally {
    state.copyRunning = false;
    updateCopyButton();
  }
}

async function loadInitialData() {
  try {
    const health = await fetchJson("/api/health");
    if (health.readOnly && els.refreshButton) {
      els.refreshButton.disabled = true;
      els.refreshButton.textContent = "Scheduled at 08:00 GMT+7";
      els.refreshButton.title = "Refreshes run from GitHub Actions and are read-only here.";
    }
  } catch {
    // The data requests below provide the visible error state if health is unavailable.
  }
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
  updateCopyButton();
  state.refreshPollId = snapshotId;

  while (state.refreshPollId === snapshotId) {
    const payload = await fetchJson(`/api/signals/refresh/${snapshotId}/status`);
    updateSummary(payload.snapshot || null, state.runSummary);

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
    updateCopyButton();
    await loadSnapshots(snapshotId);
    await loadSnapshotRows();
    return;
  }
}

async function pollSpotRefresh() {
  state.refreshRunning = true;
  els.refreshButton.disabled = true;
  updateCopyButton();

  for (;;) {
    const payload = await fetchJson("/api/spot-holdings/refresh/status");

    if (payload.running) {
      const logs = Array.isArray(payload.logs) ? payload.logs : [];
      const latestLog = logs[logs.length - 1] || "Scanning Hypurrscan spot holdings...";
      setBanner(latestLog, "warning");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      continue;
    }

    state.refreshRunning = false;
    els.refreshButton.disabled = false;
    updateCopyButton();

    if (payload.lastError) {
      setBanner(payload.lastError, "danger");
      await loadSnapshotRows();
      return;
    }

    await loadSnapshotRows();
    const result = payload.lastResult || {};
    setBanner(
      `Spot refresh complete. Scanned ${Number(result.tradersScanned || 0)} traders; ${Number(result.tradersWithFilteredHoldings || 0)} had non-stable holdings above threshold.`,
      "success",
    );
    return;
  }
}

async function pollCombinedRefresh(snapshotId) {
  state.refreshRunning = true;
  els.refreshButton.disabled = true;
  updateCopyButton();
  state.refreshPollId = snapshotId;

  let latestSignalPayload = null;
  let latestSpotPayload = null;

  while (state.refreshPollId === snapshotId) {
    const [signalPayload, spotPayload] = await Promise.all([
      fetchJson(`/api/signals/refresh/${snapshotId}/status`),
      fetchJson("/api/spot-holdings/refresh/status"),
    ]);
    latestSignalPayload = signalPayload;
    latestSpotPayload = spotPayload;

    updateSummary(signalPayload.snapshot || null, state.runSummary);

    const runtime = signalPayload.runtime || {};
    if (runtime.canContinue) {
      setBanner("Refresh running. Continuing the next trader batch while Spot scan continues...", "warning");
      await fetchJson(`/api/signals/refresh/${snapshotId}/continue`, { method: "POST" });
      await loadSnapshots(snapshotId);
      await loadSnapshotRows();
      continue;
    }

    const signalsRunning = runtime.running || signalPayload.snapshot?.status === "running";
    const spotRunning = Boolean(spotPayload.running);
    if (signalsRunning || spotRunning) {
      if (spotRunning) {
        const logs = Array.isArray(spotPayload.logs) ? spotPayload.logs : [];
        const latestLog = logs[logs.length - 1] || "Scanning Hypurrscan spot holdings...";
        setBanner(`Refresh running. ${latestLog}`, "warning");
      } else {
        const runs = Array.isArray(signalPayload.runs) ? signalPayload.runs : [];
        const failed = runs.filter((run) => run.status === "failed");
        setBanner(
          failed.length
            ? `Refresh running. ${failed.length} trader scrapes have failed so far.`
            : "Refresh running. Gathering trader positions from Hypurrscan...",
          "warning",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
      continue;
    }

    break;
  }

  state.refreshPollId = null;
  state.refreshRunning = false;
  els.refreshButton.disabled = false;
  updateCopyButton();

  await loadSnapshots(snapshotId);
  await loadSnapshotRows();

  const signalStatus = latestSignalPayload?.snapshot?.status;
  if (latestSpotPayload?.lastError) {
    setBanner(`Signals ${signalStatus || "finished"}; Spot refresh failed: ${latestSpotPayload.lastError}`, "warning");
    return;
  }

  setBanner(
    signalStatus === "partial"
      ? "Refresh complete. Signals finished with partial failures; Spot holdings refreshed."
      : signalStatus === "failed"
        ? latestSignalPayload?.snapshot?.error_message || "Signal refresh failed; Spot holdings refreshed."
        : "Refresh complete. Signals and Spot holdings are updated.",
    signalStatus === "failed" ? "danger" : signalStatus === "partial" ? "warning" : "success",
  );
}

els.refreshButton.addEventListener("click", async () => {
  try {
    if (isSpotView()) {
      setBanner("Starting Hypurrscan spot holdings refresh...", "warning");
      state.refreshRunning = true;
      els.refreshButton.disabled = true;
      updateCopyButton();
      await fetchJson("/api/spot-holdings/refresh", { method: "POST" });
      void pollSpotRefresh().catch((error) => {
        state.refreshRunning = false;
        els.refreshButton.disabled = false;
        updateCopyButton();
        setBanner((error && error.message) || String(error), "danger");
      });
      return;
    }
    setBanner("");
    const payload = await fetchJson("/api/signals/refresh", { method: "POST" });
    await loadSnapshots(payload.snapshotId);
    await loadSnapshotRows();
    void pollCombinedRefresh(payload.snapshotId).catch((error) => {
      state.refreshRunning = false;
      els.refreshButton.disabled = false;
      updateCopyButton();
      setBanner((error && error.message) || String(error), "danger");
    });
  } catch (error) {
    state.refreshRunning = false;
    els.refreshButton.disabled = false;
    updateCopyButton();
    setBanner((error && error.message) || String(error), "danger");
  }
});

els.logoutButton.addEventListener("click", async () => {
  await fetchJson("/api/auth/logout", { method: "POST" });
  window.location.href = "/login";
});

els.copyButton.addEventListener("click", () => {
  void copySignalExport();
});

els.snapshotSelect.addEventListener("change", async (event) => {
  state.selectedSnapshotId = Number(event.target.value || 0) || null;
  state.drilldowns.clear();
  updateCopyButton();
  await loadSnapshotRows();
});

els.tableHead.addEventListener("click", (event) => {
  const button = event.target.closest("[data-sort-key]");
  if (!button) return;
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

for (const button of els.marketTabs) {
  button.addEventListener("click", async () => {
    const nextMarket = button.dataset.market;
    state.market = nextMarket === "tradfi" || nextMarket === "spot" ? nextMarket : "crypto";
    state.sortKey = state.market === "spot" ? "holdersCount" : "smwFlows";
    state.sortDir = "desc";
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
  if (isSpotView()) return;
  if (state.openToken === token) {
    await ensureDrilldown(token);
  }
});

void loadInitialData().catch((error) => {
  setBanner((error && error.message) || String(error), "danger");
});
