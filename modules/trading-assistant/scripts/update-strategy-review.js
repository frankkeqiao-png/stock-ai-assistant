const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SNAPSHOT_JSON = path.join(DATA_DIR, "trading-assistant.json");
const SNAPSHOT_JS = path.join(DATA_DIR, "trading-assistant.js");
const STRATEGY_LOG_JSON = path.join(DATA_DIR, "trading-assistant-strategy-log.json");
const STRATEGY_UPGRADE_STATE_JSON = path.join(DATA_DIR, "trading-assistant-strategy-upgrade-state.json");

const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_JSON, "utf8"));
const logs = appendStrategyLog(snapshot);
snapshot.strategyReview = buildStrategyReview(logs, snapshot);
applyStrategyUpgradeState(snapshot);
fs.writeFileSync(SNAPSHOT_JSON, JSON.stringify(snapshot, null, 2), "utf8");
fs.writeFileSync(SNAPSHOT_JS, `window.TRADING_ASSISTANT_DATA = ${JSON.stringify(snapshot, null, 2)};\n`, "utf8");
console.log(JSON.stringify({
  generatedAtChina: snapshot.generatedAtChina,
  sampleCount: snapshot.strategyReview.sampleCount,
  suggestions: snapshot.strategyReview.suggestions.length
}, null, 2));

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function applyStrategyUpgradeState(snapshot) {
  const state = readJsonFile(STRATEGY_UPGRADE_STATE_JSON, { confirmed: [], history: [] });
  const confirmed = state.confirmed || [];
  snapshot.strategyUpgradeState = state;
  snapshot.strategyReview ||= {};
  snapshot.strategyReview.confirmedUpgrades = confirmed;
  for (const suggestion of snapshot.strategyReview.suggestions || []) {
    const record = confirmed.find(item => item.title === suggestion.title);
    if (record) {
      suggestion.status = "已升级";
      suggestion.confirmedAt = record.decidedAt || "";
    }
  }
}

function appendStrategyLog(snapshot) {
  let logs = [];
  try {
    if (fs.existsSync(STRATEGY_LOG_JSON)) {
      const parsed = JSON.parse(fs.readFileSync(STRATEGY_LOG_JSON, "utf8"));
      if (Array.isArray(parsed)) logs = parsed;
    }
  } catch {
    logs = [];
  }
  const entry = {
    generatedAt: snapshot.generatedAt,
    generatedAtChina: snapshot.generatedAtChina,
    candidateCount: snapshot.candidates.length,
    states: snapshot.audit.coverage.states,
    groups: snapshot.candidateGroups.map(group => ({ name: group.name, count: group.count })),
    dataQuality: snapshot.dataQuality?.unavailable || [],
    candidates: snapshot.candidates.map(candidate => ({
      code: candidate.code,
      name: candidate.name,
      price: candidate.price,
      pct: candidate.pct,
      focusArea: candidate.focus?.area,
      state: candidate.tradePlan?.state,
      score: candidate.tradePlan?.score,
      buyType: candidate.tradePlan?.buyType,
      trendStage: candidate.tradePlan?.trendStage?.stage || candidate.technical?.trendStage?.stage,
      relativeStrength: candidate.tradePlan?.relativeStrength?.score || candidate.technical?.relativeStrength?.score,
      riskReward: candidate.tradePlan?.riskReward?.ratio,
      votePass: candidate.tradePlan?.strategyVotes?.passCount,
      voteFail: candidate.tradePlan?.strategyVotes?.failCount,
      stop: candidate.tradePlan?.stop,
      takeProfit: candidate.tradePlan?.takeProfit
    }))
  };
  const last = logs[logs.length - 1];
  if (!last || last.generatedAt !== entry.generatedAt) logs.push(entry);
  logs = logs.slice(-180);
  fs.writeFileSync(STRATEGY_LOG_JSON, JSON.stringify(logs, null, 2), "utf8");
  return logs;
}

function buildStrategyReview(logs, snapshot) {
  const current = logs[logs.length - 1];
  const previous = logs.length > 1 ? logs[logs.length - 2] : null;
  const candidates = snapshot.candidates || [];
  const avg = rows => rows.length ? round(rows.reduce((sum, item) => sum + Number(item || 0), 0) / rows.length, 2) : null;
  const byState = {};
  for (const candidate of candidates) {
    const state = candidate.tradePlan?.state || "未分类";
    if (!byState[state]) byState[state] = [];
    byState[state].push(candidate);
  }
  const stateMetrics = Object.fromEntries(Object.entries(byState).map(([state, rows]) => [state, {
    count: rows.length,
    avgScore: avg(rows.map(row => row.tradePlan?.score)),
    avgRiskReward: avg(rows.map(row => row.tradePlan?.riskReward?.ratio).filter(Number.isFinite)),
    avgRelativeStrength: avg(rows.map(row => row.tradePlan?.relativeStrength?.score || row.technical?.relativeStrength?.score).filter(Number.isFinite))
  }]));
  const previousCodes = new Set(previous?.candidates?.map(candidate => candidate.code) || []);
  const currentCodes = new Set(current?.candidates?.map(candidate => candidate.code) || []);
  const overlap = previous ? [...currentCodes].filter(code => previousCodes.has(code)).length : null;
  const observations = [];
  const suggestions = [];
  const blockedRatio = candidates.length ? (byState["暂不交易"]?.length || 0) / candidates.length : 0;
  const readyCount = byState["交易准备池"]?.length || 0;
  const trackingCount = byState["重点跟踪池"]?.length || 0;

  if (logs.length < 7) observations.push("策略日志样本少于7次刷新，当前只做结构性检查，不做参数调整结论。");
  if (blockedRatio > 0.75) {
    observations.push(`暂不交易占比 ${round(blockedRatio * 100, 1)}%，说明当前市场或规则偏谨慎，需要后续复盘确认是否过严。`);
    suggestions.push({
      title: "观察风险收益比和趋势阶段门槛是否过严",
      reason: "暂不交易占比持续过高会降低选股覆盖度，但短期高占比也可能只是市场结构弱。",
      proposedChange: "连续5次刷新暂不交易占比仍高于75%时，再评估是否微调风险收益比门槛或趋势阶段扣分。",
      status: "待你确认后才执行"
    });
  }
  if (readyCount + trackingCount === 0) observations.push("当前没有交易准备池或重点跟踪池，需要避免强行推荐。");
  if ((snapshot.dataQuality?.unavailable || []).length) observations.push("存在数据源限制，相关字段不会参与硬性加减分，避免用缺失数据推导结论。");
  if (previous && overlap !== null) observations.push(`与上次刷新候选重合 ${overlap}/${current.candidateCount}，用于观察候选池稳定性。`);

  suggestions.push({
    title: "建立后续收益回看",
    reason: "当前日志已记录信号，但还需要在1/3/5/10/20个交易日后回看表现，才能判断策略是否真的有效。",
    proposedChange: "后续增加收益追踪脚本，统计交易准备池、重点跟踪池、观察池的分层表现。",
    status: "待你确认后开发"
  });

  return {
    generatedAtChina: snapshot.generatedAtChina,
    sampleCount: logs.length,
    reviewMode: logs.length < 20 ? "样本积累期" : "可开始月度复盘",
    cadence: ["每日记录每次刷新", "每周轻复盘", "每月正式复盘", "季度调参建议", "半年框架评估"],
    guardrails: [
      "不因单日偏差自动改策略",
      "不自动改变你的行业偏好和风险偏好",
      "策略调整只生成建议，必须经你确认后执行",
      "把偏差区分为策略问题、数据问题、市场突发、执行条件未满足和不可归因"
    ],
    currentDistribution: snapshot.audit.coverage.states,
    stateMetrics,
    stability: previous ? {
      previousRefresh: previous.generatedAtChina,
      overlapWithPrevious: overlap,
      currentCount: current.candidateCount,
      previousCount: previous.candidateCount
    } : null,
    observations,
    suggestions,
    timeline: buildReviewTimeline(logs)
  };
}

function buildReviewTimeline(logs) {
  const safeLogs = (logs || []).filter(entry => entry?.generatedAt || entry?.generatedAtChina);
  return {
    daily: groupReviewEntries(safeLogs, dateKey).reverse(),
    weekly: groupReviewEntries(safeLogs, weekKey).reverse(),
    monthly: groupReviewEntries(safeLogs, monthKey).reverse()
  };
}

function groupReviewEntries(logs, keyFn) {
  const groups = new Map();
  for (const entry of logs || []) {
    const key = keyFn(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.entries()].map(([key, entries]) => summarizeReviewEntries(key, entries, "period"));
}

function summarizeReviewEntries(key, entries, type) {
  const rows = [...(entries || [])].sort((a, b) => String(a.generatedAt || a.generatedAtChina).localeCompare(String(b.generatedAt || b.generatedAtChina)));
  const latest = rows[rows.length - 1] || {};
  const candidateCounts = rows.map(row => Number(row.candidateCount)).filter(Number.isFinite);
  const avgCandidateCount = candidateCounts.length ? round(candidateCounts.reduce((sum, value) => sum + value, 0) / candidateCounts.length, 1) : null;
  const stateTotals = {};
  for (const row of rows) {
    for (const [state, count] of Object.entries(row.states || {})) {
      stateTotals[state] = (stateTotals[state] || 0) + Number(count || 0);
    }
  }
  const stateAverages = Object.fromEntries(Object.entries(stateTotals).map(([state, count]) => [state, round(count / Math.max(1, rows.length), 1)]));
  const topCandidates = [...(latest.candidates || [])]
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 8)
    .map(candidate => ({
      code: candidate.code,
      name: candidate.name,
      focusArea: candidate.focusArea,
      state: candidate.state,
      score: candidate.score,
      buyType: candidate.buyType,
      riskReward: candidate.riskReward
    }));
  const dataQuality = [...new Map(rows.flatMap(row => row.dataQuality || []).map(item => [item.field, item])).values()];
  return {
    key,
    type,
    refreshCount: rows.length,
    firstRefresh: rows[0]?.generatedAtChina || rows[0]?.generatedAt || "",
    latestRefresh: latest.generatedAtChina || latest.generatedAt || "",
    candidateCount: latest.candidateCount ?? null,
    avgCandidateCount,
    states: latest.states || {},
    stateAverages,
    groups: latest.groups || [],
    dataQuality,
    topCandidates
  };
}

function dateKey(entry) {
  const text = String(entry?.generatedAtChina || entry?.generatedAt || "");
  const match = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (match) return `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? "unknown-date" : date.toISOString().slice(0, 10);
}

function monthKey(entry) {
  return dateKey(entry).slice(0, 7);
}

function weekKey(entry) {
  const date = new Date(`${dateKey(entry)}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return "unknown-week";
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return `${date.toISOString().slice(0, 10)}周`;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}
