function drawBreadthChart(data) {
  const narrow=window.matchMedia("(max-width: 520px)").matches;
  const W=narrow?440:1120,H=narrow?280:300,L=narrow?36:52,R=narrow?62:82,T=24,B=narrow?42:34, plotW=W-L-R, plotH=H-T-B, n=data.down.length;
  const x=i=>L+(i/(n-1))*plotW, y=v=>T+((100-v)/100)*plotH;
  const line=values=>values.map((v,i)=>`${i?"L":"M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const hold=data.down.map((v,i)=>100-v-data.up[i]);
  const grid=[0,25,50,75,100].map(v=>`<line x1="${L}" y1="${y(v)}" x2="${W-R}" y2="${y(v)}" stroke="rgba(255,255,255,.12)"/><text x="${L-10}" y="${y(v)+4}" fill="#a4a8ac" font-size="11" text-anchor="end">${v}%</text>`).join("");
  const threshold=`<line x1="${L}" y1="${y(60)}" x2="${W-R}" y2="${y(60)}" stroke="#f34e54" stroke-width="1.4" stroke-dasharray="3 4"/><rect x="${L+5}" y="${y(60)-19}" width="180" height="18" rx="4" fill="#191b1d"/><text x="${L+10}" y="${y(60)-6}" fill="#ff898d" font-size="11" font-weight="700">EXTREME THRESHOLD · 60%</text>`;
  const datePoints=narrow?[0,Math.floor((n-1)*.5),n-1]:[0,Math.floor((n-1)*.25),Math.floor((n-1)*.5),Math.floor((n-1)*.75),n-1];
  const dateLabels=datePoints.map(i=>`<text x="${x(i)}" y="${H-7}" fill="#a4a8ac" font-size="${narrow?13:11}" text-anchor="middle">${data.dates[i]}</text>`).join("");
  const endLabel=(values,color,txt)=>`<text x="${W-R+9}" y="${y(values.at(-1))+4}" fill="${color}" font-size="13" font-weight="800">${txt}</text>`;
  const maxDown=Math.max(...data.down), peakIndex=data.down.indexOf(maxDown);
  const peak=`<circle cx="${x(peakIndex)}" cy="${y(maxDown)}" r="4" fill="#f34e54" stroke="#fff" stroke-width="1.5"/><text x="${x(peakIndex)}" y="${y(maxDown)-11}" fill="#ff898d" text-anchor="middle" font-size="10" font-weight="700">PEAK ${maxDown}%</text>`;
  const svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Breadth lines: UP ${data.up.at(-1)} percent, DOWN ${data.down.at(-1)} percent, HODL ${hold.at(-1).toFixed(1)} percent; 60 percent extreme threshold"><title>Market breadth and 60 percent extreme threshold</title>${grid}${threshold}<path d="${line(data.up)}" fill="none" stroke="#8bd35b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="${line(data.down)}" fill="none" stroke="#f34e54" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="${line(hold)}" fill="none" stroke="#6486f5" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${peak}<circle cx="${x(n-1)}" cy="${y(data.down.at(-1))}" r="4" fill="#f34e54"/>${endLabel(data.down,"#f34e54",`▼ ${data.down.at(-1)}%`)}${endLabel(hold,"#829aff",`↔ ${hold.at(-1).toFixed(1)}%`)}${endLabel(data.up,"#8bd35b",`▲ ${data.up.at(-1)}%`)}${dateLabels}</svg>`;
  document.getElementById("health-chart").innerHTML=svg;
  const activity=document.getElementById("health-activity"); activity.innerHTML="";
  const values=data.changed.slice(-20), max=Math.max(1,...values);
  values.forEach((v,i)=>{const bar=document.createElement("span");bar.style.height=`${Math.max(12,v/max*100)}%`;bar.title=`${data.dates[data.changed.length-values.length+i]}: ${v} changed`;activity.append(bar);});
}

function liveBreadth(payload) {
  const health=payload.health?.data, rows=payload.history?.data;
  if (!health?.trends || !Array.isArray(rows)) throw new Error("Incomplete Shumi breadth response");
  const byDay=new Map();
  rows.forEach(row=>{
    const date=new Date(row.date);
    if (!Number.isFinite(date.getTime()) || !["UP","DOWN","HODL"].includes(row.trend)) return;
    const key=date.toISOString().slice(0,10);
    const day=byDay.get(key)||{date,UP:0,DOWN:0,HODL:0};
    day[row.trend]=Number(row.amount)||0;
    byDay.set(key,day);
  });
  const days=[...byDay.values()].sort((a,b)=>a.date-b.date).slice(-30);
  if (days.length<2) throw new Error("Shumi history has fewer than two daily readings");
  const pct=(day,state)=>{const total=day.UP+day.DOWN+day.HODL;return total?+(100*day[state]/total).toFixed(1):0};
  const down=days.map(day=>pct(day,"DOWN")),up=days.map(day=>pct(day,"UP"));
  const latest=down.at(-1), peak=Math.max(...down), peakIndex=down.indexOf(peak);
  const comparison=health.reading?.comparison||{};
  const extreme=latest>=60?"active":peak>=60?"cleared":"none";
  const headline=extreme==="active"?"Downside breadth is at an extreme":extreme==="cleared"?"The downside extreme has cleared":"Breadth is below the extreme threshold";
  const detail=extreme==="active"?`${latest}% of reporting coins are DOWN, above the 60% threshold.`:extreme==="cleared"?`DOWN breadth crossed 60% and peaked at ${peak}% on ${days[peakIndex].date.toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"})}. It has since eased to ${latest}%; the prior extreme remains visible in the chart.`:`DOWN breadth is ${latest}%; the 60% threshold has not been reached in this series.`;
  return {up,down,dates:days.map(day=>day.date.toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"})),changed:[],reporting:health.total,changedCount:comparison.changedCount??0,changedPct:comparison.matchedCoins?`${(100*(comparison.changedCount||0)/comparison.matchedCoins).toFixed(1)}%`:"—",headline,detail,status:extreme==="active"?"DOWN EXTREME · ACTIVE":extreme==="cleared"?"RECENT DOWN EXTREME · CLEARED":"NO CURRENT EXTREME",lastDate:`LATEST · ${days.at(-1).date.toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"}).toUpperCase()}`};
}

function renderBreadth(d) {
  drawBreadthChart(d);
  document.getElementById("health-regime").textContent=d.status;
  document.getElementById("health-message").textContent=d.headline;
  document.getElementById("health-explanation").textContent=d.detail;
  document.getElementById("health-last-date").textContent=d.lastDate;
}
window.marketHealthPromise=fetch("/api/market-regime-breadth").then(async response=>{if(!response.ok) throw new Error((await response.json()).error||"Market feed unavailable");return response.json();});
window.marketHealthPromise.then(payload=>{
  renderBreadth(liveBreadth(payload));
  document.querySelector(".market-health__activity-label span").textContent="DAILY CHANGE SERIES UNAVAILABLE";
  document.querySelector(".market-health__sample").textContent=payload.source?.startsWith("Shumi")?"SHUMI · DAILY":"COINROTATOR · DAILY";
  document.querySelector(".market-health__foot>span").textContent=`${payload.source||"Market data"} · captured ${new Date(payload.capturedAt).toLocaleString()}`;
}).catch(error=>{
  document.querySelector(".market-health__sample").textContent="MARKET DATA UNAVAILABLE";
  document.getElementById("health-regime").textContent="UNAVAILABLE";
  document.getElementById("health-message").textContent="Breadth reading unavailable";
  document.getElementById("health-explanation").textContent="The source could not be checked. Try again later.";
  document.getElementById("health-chart").textContent="No verified breadth history is available.";
  document.querySelector(".market-health__foot>span").textContent="Market source unavailable";
});
