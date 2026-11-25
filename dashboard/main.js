const fmtUsd = (value) =>
  Number(value || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });

const els = {
  runScan: document.getElementById("run-scan"),
  scanStatus: document.getElementById("scan-status"),
  logs: document.getElementById("logs"),
  lastScan: document.getElementById("last-scan"),
  snapshotSelect: document.getElementById("snapshot-select"),
  clusterSearch: document.getElementById("cluster-search"),
  clusterBody: document.getElementById("cluster-body"),
  walletSelect: document.getElementById("wallet-select"),
  walletBody: document.getElementById("wallet-body"),
  walletExtra: document.getElementById("wallet-extra"),
  compareA: document.getElementById("compare-a"),
  compareB: document.getElementById("compare-b"),
  loadDiff: document.getElementById("load-diff"),
  diffBody: document.getElementById("diff-body"),
};

let scans = [];
let clusters = [];

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

function setStatus(text) {
  els.scanStatus.textContent = text;
}

function renderSnapshotOptions() {
  const optionsHtml = scans
    .map(
      (scan) =>
        `<option value="${scan.id}">#${scan.id} - ${new Date(scan.created_at).toLocaleString()}</option>`,
    )
    .join("");

  els.snapshotSelect.innerHTML = optionsHtml;
  els.compareA.innerHTML = optionsHtml;
  els.compareB.innerHTML = optionsHtml;

  if (scans.length > 1) {
    els.compareA.value = String(scans[1].id);
    els.compareB.value = String(scans[0].id);
  }
}

function renderClusters() {
  const q = (els.clusterSearch.value || "").toLowerCase();
  const filtered = clusters.filter(
    (row) =>
      row.token.toLowerCase().includes(q) ||
      row.chain.toLowerCase().includes(q) ||
      row.holders.some((holder) => holder.label.toLowerCase().includes(q)),
  );

  els.clusterBody.innerHTML = filtered
    .map((row, idx) => {
      const holders = row.holders
        .slice(0, 4)
        .map((holder) => `${holder.label}: ${fmtUsd(holder.valueUSD)}`)
        .join(" | ");
      return `
        <tr>
          <td>${idx + 1}</td>
          <td>${row.token}</td>
          <td>${row.token}</td>
          <td>${fmtUsd(row.totalValueUSD)}</td>
          <td>${row.holders.length}</td>
          <td>${holders || "-"}</td>
        </tr>
      `;
    })
    .join("");
}

async function loadClusters(snapshotId) {
  const payload = await fetchJson(`/api/clusters?snapshotId=${snapshotId}`);
  clusters = payload.clusters || [];
  renderClusters();
}

async function loadWallets(snapshotId) {
  const payload = await fetchJson(`/api/wallets?snapshotId=${snapshotId}`);
  const wallets = payload.wallets || [];
  els.walletSelect.innerHTML = wallets
    .map((wallet) => `<option value="${encodeURIComponent(wallet)}">${wallet}</option>`)
    .join("");

  if (wallets.length) {
    await loadWallet(snapshotId, wallets[0]);
  } else {
    els.walletBody.innerHTML = "";
    els.walletExtra.textContent = "No wallets in this snapshot.";
  }
}

async function loadWallet(snapshotId, walletLabel) {
  const payload = await fetchJson(
    `/api/wallet/${encodeURIComponent(walletLabel)}?snapshotId=${snapshotId}`,
  );
  const holdings = payload.holdings || [];
  els.walletBody.innerHTML = holdings
    .map(
      (row) => `
      <tr>
        <td>${row.token_name || row.token_symbol}</td>
        <td>${row.chain}</td>
        <td>${row.balance_raw || "-"}</td>
        <td>${fmtUsd(row.value_usd)}</td>
      </tr>
    `,
    )
    .join("");

  const screenshot = payload.scanRecord?.screenshot_path;
  if (screenshot) {
    const filename = screenshot.split("/").pop();
    const artifactUrl = `/api/artifacts/file?path=${encodeURIComponent(screenshot)}`;
    els.walletExtra.innerHTML = `Screenshot: <a href="${artifactUrl}" target="_blank" rel="noreferrer">${filename}</a>`;
  } else {
    els.walletExtra.textContent = "No screenshot recorded for this wallet.";
  }
}

async function loadDiff() {
  const snapshotA = Number(els.compareA.value);
  const snapshotB = Number(els.compareB.value);
  if (!snapshotA || !snapshotB) return;

  const payload = await fetchJson(`/api/diff?snapshotA=${snapshotA}&snapshotB=${snapshotB}`);
  els.diffBody.innerHTML = (payload.changes || [])
    .map((change) => {
      const cls =
        change.type === "NEW"
          ? "badge-new"
          : change.type === "EXITED"
            ? "badge-exited"
            : "badge-changed";
      return `
        <tr>
          <td class="${cls}">${change.type}</td>
          <td>${change.token}</td>
          <td>${change.chain}</td>
          <td>${change.oldValue ? fmtUsd(change.oldValue) : "-"}</td>
          <td>${change.newValue ? fmtUsd(change.newValue) : change.valueUSD ? fmtUsd(change.valueUSD) : "-"}</td>
          <td>${change.changePct ? `${change.changePct.toFixed(2)}%` : "-"}</td>
        </tr>
      `;
    })
    .join("");
}

async function refreshScans() {
  const payload = await fetchJson("/api/scans");
  scans = payload.scans || [];
  renderSnapshotOptions();

  if (scans.length) {
    const latest = scans[0];
    els.lastScan.textContent = `Last scan: #${latest.id} at ${new Date(latest.created_at).toLocaleString()} | Wallets: ${latest.wallets_scanned} | Total: ${fmtUsd(latest.total_value_usd)}`;
    const selected = Number(els.snapshotSelect.value || latest.id);
    await loadClusters(selected);
    await loadWallets(selected);
  } else {
    els.lastScan.textContent = "No scan history yet.";
    els.clusterBody.innerHTML = "";
    els.walletBody.innerHTML = "";
  }
}

async function refreshStatus() {
  const payload = await fetchJson("/api/scan/status");
  setStatus(payload.running ? "Running" : "Idle");
  els.runScan.disabled = Boolean(payload.running);
  els.logs.textContent = (payload.logs || []).slice(-120).join("\n");
}

els.runScan.addEventListener("click", async () => {
  try {
    await fetchJson("/api/scan", { method: "POST" });
    await refreshStatus();
  } catch (error) {
    alert(String(error.message || error));
  }
});

els.snapshotSelect.addEventListener("change", async () => {
  const snapshotId = Number(els.snapshotSelect.value);
  if (!snapshotId) return;
  await loadClusters(snapshotId);
  await loadWallets(snapshotId);
});

els.clusterSearch.addEventListener("input", () => renderClusters());

els.walletSelect.addEventListener("change", async () => {
  const snapshotId = Number(els.snapshotSelect.value);
  const wallet = decodeURIComponent(els.walletSelect.value);
  if (!snapshotId || !wallet) return;
  await loadWallet(snapshotId, wallet);
});

els.loadDiff.addEventListener("click", async () => {
  try {
    await loadDiff();
  } catch (error) {
    alert(String(error.message || error));
  }
});

async function boot() {
  await refreshScans();
  await refreshStatus();
  setInterval(() => {
    void refreshStatus();
  }, 2500);
  setInterval(() => {
    void refreshScans();
  }, 15_000);
}

void boot();
