const HORIZONS = [3, 5, 10, 20];
const MIN_10_DAY_SAMPLES = 30;
const MIN_20_DAY_SAMPLES = 20;

function round(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function median(values) {
  const rows = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return round(rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2);
}

function summarize(values) {
  const rows = values.filter(Number.isFinite);
  return {
    samples: rows.length,
    averagePct: rows.length ? round(rows.reduce((sum, value) => sum + value, 0) / rows.length) : null,
    medianPct: median(rows),
    winRatePct: rows.length ? round(rows.filter(value => value > 0).length / rows.length * 100, 1) : null
  };
}

function addDays(dateText, days) {
  const value = new Date(`${dateText}T00:00:00+08:00`);
  if (Number.isNaN(value.getTime())) return "";
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
}

function outcomeForRecord(record, benchmarkPoints) {
  const firstPrice = Number(record.firstPrice);
  const points = (record.priceHistory || [])
    .filter(point => point?.date && Number.isFinite(Number(point.close)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!firstPrice || !points.length || !record.firstDate) return null;
  const returnAt = days => {
    const point = points.find(item => String(item.date) >= addDays(record.firstDate, days));
    return point ? round((Number(point.close) / firstPrice - 1) * 100) : null;
  };
  const benchmarkBase = benchmarkPoints.find(point => String(point.date) >= String(record.firstDate));
  const benchmarkReturnAt = days => {
    if (!benchmarkBase) return null;
    const point = benchmarkPoints.find(item => String(item.date) >= addDays(record.firstDate, days));
    return point ? round((Number(point.close) / Number(benchmarkBase.close) - 1) * 100) : null;
  };
  const path = points.map(point => (Number(point.close) / firstPrice - 1) * 100);
  return {
    pricePoints: points.length,
    latestDate: points[points.length - 1].date,
    latestReturnPct: round(path[path.length - 1]),
    maxGainPct: round(Math.max(...path)),
    maxDrawdownPct: round(Math.min(...path)),
    returns: Object.fromEntries(HORIZONS.map(days => [`d${days}`, returnAt(days)])),
    benchmarkReturns: Object.fromEntries(HORIZONS.map(days => [`d${days}`, benchmarkReturnAt(days)]))
  };
}

function summaryForRows(rows) {
  const outcomes = rows.map(row => row.outcome).filter(Boolean);
  return {
    records: rows.length,
    matureRecords: outcomes.filter(outcome => outcome.pricePoints >= 2).length,
    latestReturn: summarize(outcomes.map(outcome => outcome.latestReturnPct)),
    maxGain: summarize(outcomes.map(outcome => outcome.maxGainPct)),
    maxDrawdown: summarize(outcomes.map(outcome => outcome.maxDrawdownPct)),
    horizons: Object.fromEntries(HORIZONS.map(days => {
      const stock = outcomes.map(outcome => outcome.returns[`d${days}`]);
      const excess = outcomes.map(outcome => {
        const value = outcome.returns[`d${days}`];
        const benchmark = outcome.benchmarkReturns[`d${days}`];
        return Number.isFinite(value) && Number.isFinite(benchmark) ? round(value - benchmark) : null;
      });
      return [`d${days}`, { ...summarize(stock), excess: summarize(excess) }];
    }))
  };
}

function groupedSummary(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const group = String(row[key] || "未分类");
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  return [...groups.entries()]
    .map(([name, groupRows]) => ({ name, ...summaryForRows(groupRows) }))
    .sort((a, b) => b.records - a.records || a.name.localeCompare(b.name));
}

function buildArchiveOutcomeReview(tracking, generatedAtChina = "", benchmark = {}) {
  const benchmarkPoints = (benchmark?.history || [])
    .filter(point => point?.date && Number.isFinite(Number(point.close)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const records = (tracking?.records || []).map(record => ({
    ...record,
    reviewState: record.firstState || "未分类",
    reviewSector: record.sector || record.currentSector || "未分类",
    outcome: outcomeForRecord(record, benchmarkPoints)
  }));
  const allPoints = records.flatMap(record => record.priceHistory || []).map(point => point.date).filter(Boolean).sort();
  const overall = summaryForRows(records);
  const stateRows = groupedSummary(records, "reviewState");
  const sectorRows = groupedSummary(records, "reviewSector");
  const eligible10 = overall.horizons.d10.samples;
  const eligible20 = overall.horizons.d20.samples;
  const requiredStates = ["暂不交易", "交易准备池", "重点跟踪池"];
  const stateGate = requiredStates.map(name => {
    const row = stateRows.find(item => item.name === name);
    return {
      name,
      samples10: row?.horizons?.d10?.samples || 0,
      samples20: row?.horizons?.d20?.samples || 0,
      ready: (row?.horizons?.d10?.samples || 0) >= MIN_10_DAY_SAMPLES && (row?.horizons?.d20?.samples || 0) >= MIN_20_DAY_SAMPLES
    };
  });
  const readyForParameterChange = stateGate.every(item => item.ready);
  const observations = [
    `历史档案覆盖 ${records.length} 只曾推荐股票；其中 ${overall.matureRecords} 只具备至少两期价格轨迹。`,
    `总体 10 日有效样本 ${eligible10} 条、20 日有效样本 ${eligible20} 条；参数调整要求暂不交易、交易准备池、重点跟踪池三个分层分别达到 ${MIN_10_DAY_SAMPLES}/${MIN_20_DAY_SAMPLES} 条。`
  ];
  observations.push(benchmarkPoints.length
    ? `已使用${benchmark?.name || "沪深300"} ${benchmarkPoints[0].date} 至 ${benchmarkPoints[benchmarkPoints.length - 1].date} 的日线计算同持有期超额收益。`
    : "基准日线暂未取得，本次仅展示绝对收益，不据此判断选股超额能力。");
  if (!readyForParameterChange) {
    observations.push("结果仅用于验证分层方向和识别风险，不触发评分、买点、止损或行业权重的自动调整。");
  }
  const paused = stateRows.find(row => row.name === "暂不交易");
  const actionable = stateRows.filter(row => row.name === "交易准备池" || row.name === "重点跟踪池");
  const actionable10 = actionable.reduce((sum, row) => sum + Number(row.horizons.d10.samples || 0), 0);
  if (paused?.horizons.d10.samples && actionable10) {
    observations.push(`分层对比已纳入复盘：暂不交易 10 日样本 ${paused.horizons.d10.samples} 条；可操作分层合计 ${actionable10} 条。仅在两端样本均达标后，才评估门槛是否过严。`);
  }
  return {
    version: "archive-outcome-review-v1",
    status: "已启用",
    generatedAtChina,
    coverage: {
      records: records.length,
      matureRecords: overall.matureRecords,
      firstPriceDate: allPoints[0] || "",
      latestPriceDate: allPoints[allPoints.length - 1] || ""
    },
    benchmark: {
      name: benchmark?.name || "沪深300",
      status: benchmarkPoints.length ? "已取得" : "未取得",
      points: benchmarkPoints.length,
      firstDate: benchmarkPoints[0]?.date || "",
      latestDate: benchmarkPoints[benchmarkPoints.length - 1]?.date || ""
    },
    adjustmentGate: {
      ready: readyForParameterChange,
      min10DaySamples: MIN_10_DAY_SAMPLES,
      min20DaySamples: MIN_20_DAY_SAMPLES,
      current10DaySamples: eligible10,
      current20DaySamples: eligible20,
      stateGate,
      rule: "只有在三个核心分层分别具备足够样本后，才生成交易参数调整建议；不因单日或短周期偏差改规则。"
    },
    overall,
    byState: stateRows,
    bySector: sectorRows,
    observations
  };
}

module.exports = { buildArchiveOutcomeReview };
