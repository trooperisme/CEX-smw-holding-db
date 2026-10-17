import assert from "node:assert/strict";
import test from "node:test";
import { classifySpotToken, getSpotTokenFilterConfig } from "./spot-token-filter";

test("spot token filter keeps all non-stable tokens by default", () => {
  const config = getSpotTokenFilterConfig({});

  assert.equal(classifySpotToken("HYPE", config), "displayable");
  assert.equal(classifySpotToken("kntq", config), "displayable");
  assert.equal(classifySpotToken("$NEST", config), "displayable");
  assert.equal(classifySpotToken("BTC", config), "displayable");
  assert.equal(classifySpotToken("RANDOM-AIRDROP", config), "displayable");
});

test("spot token filter can narrow to an optional include list", () => {
  const config = getSpotTokenFilterConfig({
    SPOT_HOLDING_INCLUDE_TOKENS: "HYPE,KNTQ,NEST",
  });

  assert.equal(classifySpotToken("HYPE", config), "displayable");
  assert.equal(classifySpotToken("kntq", config), "displayable");
  assert.equal(classifySpotToken("$NEST", config), "displayable");
  assert.equal(classifySpotToken("BTC", config), "unrelated");
});

test("spot token filter excludes stable and trash tokens", () => {
  const config = getSpotTokenFilterConfig({});

  assert.equal(classifySpotToken("USDC", config), "stable");
  assert.equal(classifySpotToken("FEUSD", config), "stable");
  assert.equal(classifySpotToken("USDT0", config), "stable");
  assert.equal(classifySpotToken("", config), "trash");
});
