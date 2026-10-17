import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

test("missing spot snapshot stays missing on the read-only dashboard", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "dashboard/holdings.js"), "utf8");
  const startOfBindings = source.indexOf('\nels.refreshButton.addEventListener("click"');
  assert.ok(startOfBindings > 0, "dashboard event bindings must exist");
  const elements = new Map<string, any>();
  const document = {
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, { textContent: "", innerHTML: "", className: "", classList: { add() {}, toggle() {} } });
      return elements.get(id);
    },
    querySelectorAll() { return []; },
  };
  const context = vm.createContext({ document });
  vm.runInContext(source.slice(0, startOfBindings), context);
  vm.runInContext(`state.market = "spot"; state.readOnlyHosted = true; updateSpotSummary({ generatedAt: null, summary: {}, rows: [] }); updateCopyButton(); renderSpotTable();`, context);
  assert.equal(elements.get("summary-status").textContent, "MISSING");
  assert.equal(elements.get("summary-traders").textContent, "— traders");
  assert.equal(elements.get("table-status").textContent, "Awaiting snapshot");
  assert.match(elements.get("table-body").innerHTML, /No completed spot snapshot/);
  assert.equal(elements.get("refresh-button").textContent, "Scheduled at 08:00 GMT+7");
});
