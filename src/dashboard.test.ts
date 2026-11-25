import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

function dashboard(fetcher: typeof fetch = fetch) {
  const source = fs.readFileSync(path.join(process.cwd(), "dashboard/holdings.js"), "utf8");
  const elements = new Map<string, any>();
  const makeElement = (): any => ({ textContent: "", innerHTML: "", firstChild: { textContent: "" },
    className: "", hidden: true, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, setAttribute() {}, removeAttribute() {},
    querySelector() { return makeElement(); }, querySelectorAll() { return []; }, closest() { return makeElement(); },
  });
  const document = { hidden: false, body: makeElement(), addEventListener() {},
    getElementById(id: string) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
    querySelector() { return makeElement(); }, querySelectorAll() { return []; } };
  const context = vm.createContext({ document, fetch: fetcher, queueMicrotask() {}, setInterval() {},
    window: { matchMedia() { return { matches: false }; } } });
  // Load the actual browser script and event bindings without launching its initial network requests.
  const startup = source.lastIndexOf("\nvoid loadInitialData().catch(");
  assert.ok(startup > 0);
  const withoutStartup = source.slice(0, startup);
  vm.runInContext(withoutStartup, context);
  return { context, elements, run: (code: string) => vm.runInContext(code, context) };
}

test("missing spot snapshot stays missing on the read-only dashboard", () => {
  const d = dashboard();
  d.run(`state.market = "spot"; state.readOnlyHosted = true; state.scheduledRefresh = {primaryTime:"02:17",backupTime:"06:47"}; updateSpotSummary({ generatedAt: null, summary: {}, rows: [] }); updateCopyButton(); renderSpotTable();`);
  assert.equal(d.elements.get("summary-status").textContent, "MISSING");
  assert.equal(d.elements.get("table-status").textContent, "Awaiting snapshot");
  assert.match(d.elements.get("table-body").innerHTML, /No completed spot snapshot/);
  assert.equal(d.elements.get("refresh-button").textContent, "Daily 02:17 · backup 06:47 GMT+7");
});

test("late detail response cannot populate a different snapshot cache", async () => {
  let resolve!: (response: Response) => void;
  const d = dashboard((() => new Promise<Response>((done) => { resolve = done; })) as typeof fetch);
  d.run('state.selectedSnapshotId = 1; state.viewRequestId = 1; renderTable = () => {};');
  const pending = d.run('ensureDrilldown("BTC")');
  d.run('state.selectedSnapshotId = 2; state.viewRequestId = 2; state.drilldowns.clear();');
  resolve(Response.json({ token: "BTC", longRows: [{ traderName: "Old snapshot" }], shortRows: [] }));
  await pending;
  assert.equal(d.run('state.drilldowns.size'), 0);
  assert.match(d.run('buildDrilldownCell("BTC")'), /Loading trader breakdown/);
});

test("current detail is reused only under the same snapshot and market", async () => {
  const d = dashboard((async () => Response.json({ token: "BTC", longRows: [], shortRows: [] })) as typeof fetch);
  d.run('state.selectedSnapshotId = 1; renderTable = () => {};');
  await d.run('ensureDrilldown("BTC")');
  assert.equal(d.run('state.drilldowns.has(drilldownKey("BTC"))'), true);
  d.run('state.selectedSnapshotId = 2;');
  assert.equal(d.run('state.drilldowns.has(drilldownKey("BTC"))'), false);
});

test("late order details are discarded after changing the market view", async () => {
  let resolve!: (response: Response) => void;
  const d = dashboard((() => new Promise<Response>((done) => { resolve = done; })) as typeof fetch);
  d.run('state.market = "orders"; renderTable = () => {};');
  const pending = d.run('ensureOrderDetail("BTC")');
  d.run('state.market = "crypto"; state.viewRequestId++;');
  resolve(Response.json({ detail: { asset: "BTC" } }));
  await pending;
  assert.equal(d.run('state.orderDetails.size'), 0);
});

test("Pulse request failure clears old values and rerenders the unavailable status", async () => {
  const d = dashboard((async () => { throw new Error("offline"); }) as typeof fetch);
  d.run('state.marketPulse = { coins: [{symbol:"BTCUSDT"}] }; let renders=0; renderTable = () => { renders++; };');
  await d.run('loadMarketPulse()');
  assert.equal(d.run('state.marketPulse'), null);
  assert.equal(d.run('state.marketPulseError'), true);
  assert.equal(d.run('renders'), 1);
  assert.match(d.run('renderPulseCells("BTC")'), /—/);
});
