// The headline and streak always come from the same USD quote leg.
function btcUsdPeriod(reading, expectedUnit) {
  const leg=reading?.usd;
  if (!leg || !["UP","DOWN"].includes(leg.trend) || !Number.isInteger(leg.streak) || leg.streak<1 || leg.unit!==expectedUnit) return null;
  return {trend:leg.trend,streak:leg.streak,unit:expectedUnit};
}

function renderBtcUsdPeriod(period, reading, unit) {
  const el=document.querySelector(`[data-btc-period="${period}"]`);
  if (!el) return;
  const parsed=btcUsdPeriod(reading,unit);
  const state=el.querySelector(".btc-trend__state");
  state.textContent=parsed?.trend||"UNAVAILABLE";
  state.dataset.direction=parsed?.trend||"";
  el.querySelector(".btc-trend__streak").textContent=parsed?`${parsed.streak} ${parsed.unit}`:"USD streak unavailable";
}

window.marketHealthPromise.then(payload=>{
  const snapshot=payload.btc;
  const captured=Date.parse(snapshot.capturedAt);
  if(snapshot.asset!=="BTC" || !Number.isFinite(captured) || Date.now()-captured>48*60*60*1000 || captured-Date.now()>5*60*1000) throw new Error("Source snapshot is stale or invalid");
  renderBtcUsdPeriod("daily",snapshot.daily,"days");
  renderBtcUsdPeriod("weekly",snapshot.weekly,"weeks");
  document.getElementById("btc-trend-source").textContent=`Captured ${new Date(captured).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",timeZone:"Asia/Ho_Chi_Minh"})} ICT`;
}).catch(error=>{
  renderBtcUsdPeriod("daily",null,"days");
  renderBtcUsdPeriod("weekly",null,"weeks");
  document.getElementById("btc-trend-source").textContent=error.message;
});
