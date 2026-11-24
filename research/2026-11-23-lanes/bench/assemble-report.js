// Rebuilds research/2026-11-23-agent-hq-improvement-research-report.md from research/2026-11-23-lanes/report-parts and P4. Run from the research folder.
const fs=require("fs"), p="2026-11-23-lanes/";
const r=(f)=>fs.readFileSync(p+f,"utf8").trim();
let p4=r("P4-experiment-plan.md").replace(/^# Experimental validation plan.*\n/,"## 7. Experimental validation plan\n").replace(/^## Controls and threats to validity/m,"### Controls and threats to validity").replace(/^## Reproduction/m,"### Reproduction");
const parts=["00-header","01-executive-summary","02-current-state-audit","03-research-review","03b-evaluation-telemetry","04-comparative-analysis","05-roadmap","06-implementation-proposals"].map((n)=>r("report-parts/"+n+".md")).concat([p4,r("report-parts/08-rejected-and-open.md"),r("report-parts/09-research-record.md")]);
let out=parts.join("\n\n").replace(/### 3\.7 Evaluation, telemetry and loops \(lane L8\) and orchestrator source teardown \(lane L5\)\n\nBoth lanes were still finalizing[^\n]*\n/,"");
fs.writeFileSync("2026-11-23-agent-hq-improvement-research-report.md",out); console.log("words",out.split(/\s+/).length);
