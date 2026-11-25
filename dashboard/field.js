/* A derived view of the existing snapshot. No new data source or writes. */
function fieldMoney(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function setCanvasMode(mode) {
  document.body.dataset.canvas = mode;
  for (const button of document.querySelectorAll("[data-canvas]")) {
    button.setAttribute("aria-pressed", String(button.dataset.canvas === mode));
  }
}

// Weighted binary partition uses square-root USD area to keep smaller positions legible.
function partitionExposure(items, x, y, width, height) {
  if (!items.length) return [];
  if (items.length === 1) return [{ ...items[0], x, y, width, height }];
  const total = items.reduce((sum, item) => sum + item.layoutValue, 0);
  let split = 1;
  let subtotal = items[0].layoutValue;
  while (split < items.length - 1 && Math.abs(subtotal + items[split].layoutValue - total / 2) < Math.abs(subtotal - total / 2)) subtotal += items[split++].layoutValue;
  const fraction = subtotal / total;
  return width > height
    ? [...partitionExposure(items.slice(0, split), x, y, width * fraction, height), ...partitionExposure(items.slice(split), x + width * fraction, y, width * (1 - fraction), height)]
    : [...partitionExposure(items.slice(0, split), x, y, width, height * fraction), ...partitionExposure(items.slice(split), x, y + height * fraction, width, height * (1 - fraction))];
}

function renderField() {
  const field = document.getElementById("field-map");
  const focusedToken = document.activeElement?.dataset?.fieldToken;
  if (!field) return;
  const order = isOrderView();
  const spot = isSpotView();
  document.querySelector("#exposure-field .field-legend span:first-child").textContent = spot ? "AREA / SPOT VALUE" : order ? "AREA / OPEN NOTIONAL" : "AREA / |NET USD|";
  document.getElementById("field-key").textContent = spot
    ? "Area uses √USD to keep smaller assets legible; values and portfolio shares stay exact. Open a region for holder attribution."
    : order
      ? "Area is total open bid + ask notional. Orange = bids; grey = asks. Open orders are conditional liquidity, not fills."
      : "Area uses √|long USD − short USD|; signed values show net USD direction. Tile detail shows SMW wallet balance (long wallets − short wallets), which can differ from USD direction.";
  const source = order ? state.orderDashboard?.assets || [] : state.rows || [];
  const items = source.map((row) => {
    const long = Number(order ? row.bidNotional : spot ? 0 : row.longValueUsd) || 0;
    const short = Number(order ? row.askNotional : spot ? 0 : row.shortValueUsd) || 0;
    const value = Math.max(0, Number(order ? long + short : spot ? row.totalValueUsd : row.holdingsUsd) || 0);
    return {
      id: String(order ? row.asset : row.token),
      label: String(order ? row.displayName || row.asset : row.token),
      value,
      layoutValue: Math.sqrt(value),
      long,
      short,
      longWallets: Number(row.longSmw || 0),
      shortWallets: Number(row.shortSmw || 0),
      smwFlows: Number(row.smwFlows || 0),
      holders: Number(row.holdersCount || 0),
    };
  }).filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const mobile = window.matchMedia("(max-width: 600px)").matches;
  const visible = items.slice(0, mobile ? 6 : 10);
  const visibleTotal = visible.reduce((sum, item) => sum + item.value, 0);
  const lead = visible[0];
  const noun = order ? "open notional" : spot ? "spot exposure" : "absolute net USD exposure";
  els.overviewCaption.innerHTML = lead
    ? `<span class="readout-total">${escapeHtml(fieldMoney(total))}<small>${noun}</small></span><span class="readout-conclusion"><b>${escapeHtml(lead.label)}</b> accounts for <b>${(lead.value / total * 100).toFixed(1)}%</b> of the captured ${order ? "liquidity" : "exposure"}.</span>`
    : `<span class="readout-total">—<small>No exposure available</small></span>`;
  document.getElementById("field-scope").textContent = `${visible.length} largest ${spot ? "by value" : order ? "by notional" : "by |net USD|"} / ${items.length} with exposure`;
  document.getElementById("field-coverage").textContent = total ? `${(visibleTotal / total * 100).toFixed(1)}% of total ${noun} shown` : "Awaiting a completed snapshot";
  if (!visible.length) {
    field.innerHTML = '<div class="field-empty"><span>NO SIGNAL IN RANGE</span><p>No positive USD exposure in this snapshot. Open Data table for available rows and status.</p></div>';
    return;
  }
  const selected = order ? state.openOrderAsset : state.openToken;
  const width = mobile ? 360 : 900;
  const height = mobile ? 680 : 500;
  const tiles = partitionExposure(visible, 0, 0, width, height);
  field.innerHTML = tiles.map((tile, index) => {
    const netUsd = tile.long - tile.short;
    const side = order
      ? tile.long > tile.short ? "BID LED" : tile.short > tile.long ? "ASK LED" : "BALANCED"
      : spot ? "SPOT"
        : netUsd > 0 ? "NET LONG" : netUsd < 0 ? "NET SHORT" : "BALANCED";
    const ratio = tile.long + tile.short ? tile.long / (tile.long + tile.short) * 100 : 50;
    const detail = spot ? `${tile.holders} holders` : order ? `${fieldMoney(tile.long)} bids / ${fieldMoney(tile.short)} asks` : `${tile.smwFlows > 0 ? "+" : ""}${tile.smwFlows} SMW · ${tile.longWallets}L / ${tile.shortWallets}S`;
    const valueLabel = !order && !spot ? `${netUsd > 0 ? "+" : netUsd < 0 ? "−" : ""}${fieldMoney(tile.value)}` : fieldMoney(tile.value);
    const ariaLabel = spot
      ? `Inspect ${tile.label}, ${fmtUsd(tile.value)}, ${tile.holders} holders`
      : order
        ? `Inspect ${tile.label}, ${fmtUsd(tile.value)} open notional, ${fieldMoney(tile.long)} bids and ${fieldMoney(tile.short)} asks`
        : `Inspect ${tile.label}, ${side} ${fmtUsd(tile.value)}, ${fieldMoney(tile.long)} long USD and ${fieldMoney(tile.short)} short USD, ${tile.smwFlows} net SMW wallets`;
    return `<button type="button" class="field-tile ${netUsd < 0 && !spot && !order ? "is-short" : ""} ${selected === tile.id ? "is-selected" : ""} ${tile.width < 160 || tile.height < 155 ? "is-small" : ""}" data-field-token="${escapeHtml(tile.id)}" aria-label="${escapeHtml(ariaLabel)}" aria-controls="inspector-content" aria-expanded="${selected === tile.id}" style="left:${tile.x / width * 100}%;top:${tile.y / height * 100}%;width:${tile.width / width * 100}%;height:${tile.height / height * 100}%;--weight:${Math.max(.025, .13 - index * .008)};--balance:${ratio}%">
      <span class="tile-index">${String(index + 1).padStart(2, "0")} / ${spot ? "SPOT" : side}</span>
      <span class="tile-symbol">${escapeHtml(tile.label)}</span><span class="tile-value">${escapeHtml(valueLabel)}</span>
      <span class="tile-detail">${escapeHtml(detail)}</span><span class="tile-share">${(tile.value / total * 100).toFixed(1)}% OF TOTAL <span aria-hidden="true">↗</span></span>
      ${spot ? "" : '<span class="tile-balance" aria-hidden="true"><i></i></span>'}
    </button>`;
  }).join("");
  if (focusedToken) Array.from(field.querySelectorAll("[data-field-token]")).find((tile) => tile.dataset.fieldToken === focusedToken)?.focus({ preventScroll: true });
}

setCanvasMode("map");
for (const button of document.querySelectorAll("[data-canvas]")) button.addEventListener("click", () => setCanvasMode(button.dataset.canvas));
document.getElementById("field-map").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-field-token]");
  if (!button) return;
  const token = button.dataset.fieldToken;
  if (isOrderView()) state.openOrderAsset = token;
  else state.openToken = token;
  renderTable();
  openInspectorOnMobile();
  try {
    if (isOrderView()) await ensureOrderDetail(token);
    else if (!isSpotView()) await ensureDrilldown(token);
    if (window.matchMedia("(max-width: 920px)").matches) revealSelectedPositionRow();
  } catch (error) {
    const message = `Could not load position details: ${escapeHtml(error.message || String(error))}. Select this region to retry.`;
    if (window.matchMedia("(max-width: 920px)").matches) setBanner(message, "danger");
    else els.inspectorContent.insertAdjacentHTML("beforeend", `<p role="alert">${message}</p>`);
  }
});
window.matchMedia("(max-width: 600px)").addEventListener("change", renderField);
renderField();
