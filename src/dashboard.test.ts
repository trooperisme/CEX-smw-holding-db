import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

test("missing spot snapshot stays missing on the read-only dashboard", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "dashboard/holdings.js"), "utf8");
  const startOfBindings = source.indexOf('\nels.pageLoaderRetry.addEventListener("click"');
  assert.ok(startOfBindings > 0, "dashboard event bindings must exist");
  const elements = new Map<string, any>();
  const document = {
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, { textContent: "", innerHTML: "", firstChild: { textContent: "" }, className: "", classList: { add() {}, toggle() {} } });
      return elements.get(id);
    },
    querySelector(selector: string) {
      return this.getElementById(selector);
    },
    querySelectorAll() { return []; },
  };
  const context = vm.createContext({ document, queueMicrotask() {} });
  vm.runInContext(source.slice(0, startOfBindings), context);
  vm.runInContext(`state.market = "spot"; state.readOnlyHosted = true; updateSpotSummary({ generatedAt: null, summary: {}, rows: [] }); updateCopyButton(); renderSpotTable();`, context);
  assert.equal(elements.get("summary-status").textContent, "MISSING");
  assert.equal(elements.get("summary-traders").textContent, "— traders");
  assert.equal(elements.get("table-status").textContent, "Awaiting snapshot");
  assert.match(elements.get("table-body").innerHTML, /No completed spot snapshot/);
  assert.equal(elements.get("refresh-button").textContent, "Daily scan via GitHub Actions");
});

test("position trader links preserve vault provenance, fall back to wallet and reject invalid destinations", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "dashboard/holdings.js"), "utf8");
  const context = vm.createContext({ document: { getElementById() { return {}; }, querySelector() { return {}; }, querySelectorAll() { return []; } } });
  vm.runInContext(source.slice(0, source.indexOf('\nels.pageLoaderRetry.addEventListener("click"')), context);
  const walletAddress = "0x1111111111111111111111111111111111111111";
  const render = (row: object) => { context.row = row; return vm.runInContext("positionTraderLabel(row)", context) as string; };
  const vault = render({ traderName: "Strategy", walletAddress, sourceUrl: `https://hypurrscan.io/vault/${walletAddress}` });
  assert.match(vault, /href="https:\/\/hypurrscan.io\/vault\//);
  assert.match(vault, /target="_blank" rel="noopener noreferrer"/);
  const fallback = render({ traderName: "<Trader>", walletAddress, sourceUrl: "javascript:alert(1)" });
  assert.match(fallback, /#perps/);
  assert.match(fallback, /&lt;Trader&gt;/);
  assert.doesNotMatch(fallback, /javascript:/);
  assert.doesNotMatch(render({ traderName: "Missing wallet", walletAddress: "invalid" }), /<a /);
});
