const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const snapshot = JSON.parse(fs.readFileSync(path.join(root, "data", "trading-assistant.json"), "utf8"));
const bannedSectors = new Set([
  "农业/养殖",
  "公用环保/交通",
  "教育/服务",
  "金融",
  "房地产",
  "建筑",
  "外贸"
]);

const requiredCandidatePaths = [
  ["code"],
  ["name"],
  ["price"],
  ["pct"],
  ["amountYi"],
  ["turnover"],
  ["focus", "area"],
  ["financial", "status"],
  ["financial", "reportDate"],
  ["announcements", "status"],
  ["announcements", "latest"],
  ["technical", "lastDate"],
  ["technical", "m30", "lastDate"],
  ["technical", "m5", "lastDate"],
  ["technical", "trendStage", "stage"],
  ["technical", "momentum", "r20"],
  ["technical", "relativeStrength", "score"],
  ["tradePlan", "state"],
  ["tradePlan", "score"],
  ["tradePlan", "buyType"],
  ["tradePlan", "entryZone"],
  ["tradePlan", "stop"],
  ["tradePlan", "takeProfit"],
  ["tradePlan", "riskReward", "ratio"],
  ["tradePlan", "strategyVotes", "passCount"],
  ["tradePlan", "trigger"],
  ["tradePlan", "support"],
  ["tradePlan", "risk"],
  ["tradePlan", "trackingLayer"],
  ["stability", "layer"],
  ["stability", "reason"]
];

const report = {
  generatedAtChina: snapshot.generatedAtChina,
  boards: snapshot.universe?.boards?.length || 0,
  universeStocks: snapshot.audit?.coverage?.universeStocks || snapshot.universe?.stockCount || 0,
  candidates: snapshot.candidates?.length || 0,
  actionList: snapshot.actionList?.length || 0,
  groups: (snapshot.candidateGroups || []).map(group => ({ name: group.name, count: group.count })),
  states: snapshot.audit?.coverage?.states || {},
  dataQualityUnavailable: snapshot.dataQuality?.unavailable || [],
  strategyReview: {
    exists: !!snapshot.strategyReview,
    sampleCount: snapshot.strategyReview?.sampleCount || 0,
    suggestions: snapshot.strategyReview?.suggestions?.length || 0
  },
  trackingConsistency: null,
  missing: [],
  bannedHits: [],
  warnings: []
};

const candidateCodes = [...new Set((snapshot.candidates || []).map(candidate => candidate.code))].sort();
const activeTrackingCodes = [...new Set((snapshot.recommendationTracking?.records || [])
  .filter(record => record.active)
  .map(record => record.code))].sort();
const candidateSet = new Set(candidateCodes);
const activeTrackingSet = new Set(activeTrackingCodes);
const candidateNotInTracking = candidateCodes.filter(code => !activeTrackingSet.has(code));
const trackingNotInCandidate = activeTrackingCodes.filter(code => !candidateSet.has(code));
report.trackingConsistency = {
  candidateCount: candidateCodes.length,
  activeTrackingCount: activeTrackingCodes.length,
  candidateNotInTracking,
  trackingNotInCandidate,
  note: "当前候选必须进入推荐追踪；历史推荐在未经人工确认剔除前可以继续 active，因此 activeTrackingCount 允许大于 candidateCount。",
  ok: !candidateNotInTracking.length
};
if (!report.trackingConsistency.ok) {
  report.warnings.push({
    field: "recommendationTracking.active",
    reason: "current candidate pool has stocks missing from recommendation tracking",
    candidateNotInTracking,
    trackingNotInCandidate
  });
}

for (const candidate of snapshot.candidates || []) {
  for (const path of requiredCandidatePaths) {
    if (path.join(".") === "tradePlan.riskReward.ratio" && String(candidate.tradePlan?.buyType || "").startsWith("无买点")) {
      continue;
    }
    const value = get(candidate, path);
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) {
      report.missing.push({ code: candidate.code, name: candidate.name, field: path.join(".") });
    }
  }
  if (candidate.mainNetInflowYi === null || candidate.mainNetInflowYi === undefined) {
    report.warnings.push({ code: candidate.code, name: candidate.name, field: "mainNetInflowYi", reason: candidate.capitalFlow?.reason || candidate.capitalFlow?.status || "missing" });
  }
  if (bannedSectors.has(candidate.focus?.area)) {
    report.bannedHits.push({ code: candidate.code, name: candidate.name, area: candidate.focus.area });
  }
  for (const board of candidate.boards || []) {
    if (bannedSectors.has(board.sector)) {
      report.bannedHits.push({ code: candidate.code, name: candidate.name, board: board.name, area: board.sector });
    }
  }
}

for (const group of snapshot.candidateGroups || []) {
  if (bannedSectors.has(group.name)) {
    report.bannedHits.push({ group: group.name });
  }
}

const html = fs.readFileSync(path.join(root, "trading-assistant.html"), "utf8");
try {
  new Function(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  report.htmlScript = "ok";
} catch (error) {
  report.htmlScript = String(error.message || error);
}

try {
  const js = fs.readFileSync(path.join(root, "data", "trading-assistant.js"), "utf8");
  const match = js.match(/window\.TRADING_ASSISTANT_DATA\s*=\s*([\s\S]*);?\s*$/);
  JSON.parse(match[1].replace(/;\s*$/, ""));
  report.dataJs = "ok";
} catch (error) {
  report.dataJs = String(error.message || error);
}

console.log(JSON.stringify(report, null, 2));

function get(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}
