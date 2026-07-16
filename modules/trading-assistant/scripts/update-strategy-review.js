const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SNAPSHOT_JSON = path.join(DATA_DIR, "trading-assistant.json");
const SNAPSHOT_JS = path.join(DATA_DIR, "trading-assistant.js");
const STRATEGY_LOG_JSON = path.join(DATA_DIR, "trading-assistant-strategy-log.json");

const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_JSON, "utf8"));
const logs = appendStrategyLog(snapshot);
snapshot.strategyReview = buildStrategyReview(logs, snapshot);
fs.writeFileSync(SNAPSHOT_JSON, JSON.stringify(snapshot, null, 2), "utf8");
fs.writeFileSync(SNAPSHOT_JS, `window.TRADING_ASSISTANT_DATA = ${JSON.stringify(snapshot, null, 2)};\n`, "utf8");
console.log(JSON.stringify({
  generatedAtChina: snapshot.generatedAtChina,
  sampleCount: snapshot.strategyReview.sampleCount,
  suggestions: snapshot.strategyReview.suggestions.length
}, null, 2));

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
    suggestions
  };
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}
