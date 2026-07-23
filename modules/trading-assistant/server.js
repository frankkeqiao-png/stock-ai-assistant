const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8765);
const REMOVAL_STATE_FILE = path.join(ROOT, "data", "trading-assistant-removal-state.json");
const RECOMMENDATION_TRACKING_FILE = path.join(ROOT, "data", "trading-assistant-recommendation-tracking.json");
const STRATEGY_UPGRADE_STATE_FILE = path.join(ROOT, "data", "trading-assistant-strategy-upgrade-state.json");
const STRATEGY_LOG_FILE = path.join(ROOT, "data", "trading-assistant-strategy-log.json");
const SNAPSHOT_FILE = path.join(ROOT, "data", "trading-assistant.json");
let refreshing = false;
let lastRefresh = null;
let lastRefreshError = null;
let lastRefreshStartedAt = null;
let lastRefreshOutput = "";
let currentRefreshPromise = null;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(body);
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function writeSnapshot(snapshot) {
  writeJson(SNAPSHOT_FILE, snapshot);
  const jsFile = path.join(ROOT, "data", "trading-assistant.js");
  fs.writeFileSync(jsFile, `window.TRADING_ASSISTANT_DATA = ${JSON.stringify(snapshot, null, 2)};\n`, "utf8");
}

function runDurableStateSync(mode) {
  return new Promise(resolve => {
    const args = [path.join(ROOT, "scripts", "sync-trading-assistant-state.js"), "--mode", mode];
    if (mode === "restore") args.push("--allow-missing");
    const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stderr += "state sync timeout after 130 seconds";
      child.kill();
    }, 130000);
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => {
      clearTimeout(timer);
      resolve({ ok: false, mode, error: String(error.message || error) });
    });
    child.on("close", code => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse((stdout || stderr || "{}").trim());
        resolve({ ...parsed, mode, ok: code === 0 && parsed.ok !== false });
      } catch {
        resolve({ ok: false, mode, error: (stderr || stdout || `state sync exited with ${code}`).slice(-1000) });
      }
    });
  });
}

function applyStrategyUpgradeState(snapshot, state) {
  if (!snapshot) return snapshot;
  const confirmed = state?.confirmed || [];
  snapshot.strategyUpgradeState = state || { confirmed: [], history: [] };
  snapshot.strategyUpgradeEffects = state?.effects || {};
  snapshot.strategyReview ||= {};
  snapshot.strategyReview.confirmedUpgrades = confirmed;
  for (const suggestion of snapshot.strategyReview.suggestions || []) {
    const key = inferStrategyUpgradeKey(suggestion);
    const record = confirmed.find(item => sameStrategyUpgrade(item, suggestion) || (key && inferStrategyUpgradeKey(item) === key));
    if (record) {
      suggestion.status = "已升级";
      suggestion.confirmedAt = record.decidedAt || "";
      suggestion.executionMessage = record.executionMessage || "";
    } else if (suggestion.status === "已升级" || suggestion.status === "confirmed") {
      suggestion.status = "待你确认";
      delete suggestion.confirmedAt;
      delete suggestion.executionMessage;
    }
  }
  return snapshot;
}

function inferStrategyUpgradeKey(record) {
  const explicit = String(record?.upgradeKey || record?.strategyUpgradeKey || record?.type || "").trim();
  if (explicit) return explicit;
  const id = String(record?.id || "").toLowerCase();
  if (id.includes("horizon") || id.includes("return-review")) return "horizonReturnReview";
  if (id.includes("risk") || id.includes("gate")) return "riskRewardGateReview";
  const text = String(record?.title || "");
  if (text.includes("后续收益回看") || text.includes("收益回看")) return "horizonReturnReview";
  if (text.includes("风险收益比") || text.includes("趋势阶段门槛")) return "riskRewardGateReview";
  return "";
}

function sameStrategyUpgrade(a, b) {
  const aKey = inferStrategyUpgradeKey(a);
  const bKey = inferStrategyUpgradeKey(b);
  if (aKey && bKey && aKey === bKey) return true;
  return String(a?.title || "") === String(b?.title || "");
}

function dateOnly(value) {
  const text = String(value || "");
  const match = text.match(/\d{4}[-/]\d{2}[-/]\d{2}/);
  if (match) return match[0].replace(/\//g, "-");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00+08:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function firstPointOnOrAfter(points, targetDate) {
  return points.find(point => point.date >= targetDate) || null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function calculateHorizonReturns(record) {
  const points = (record.priceHistory || [])
    .filter(point => Number.isFinite(Number(point.close)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const firstPrice = Number(record.firstPrice);
  if (!firstPrice || !points.length) return {};
  const horizons = [1, 3, 5, 10, 20];
  return Object.fromEntries(horizons.map(days => {
    const point = firstPointOnOrAfter(points, addDays(record.firstDate || dateOnly(record.firstRecommendedAtChina), days));
    return [`d${days}`, point ? {
      date: point.date,
      close: point.close,
      returnPct: round((Number(point.close) / firstPrice - 1) * 100, 2)
    } : null];
  }));
}

function executeStrategyUpgrade(record, state) {
  const snapshot = readJson(SNAPSHOT_FILE, null);
  if (!snapshot) throw new Error("snapshot missing; cannot execute strategy upgrade");
  state.effects ||= {};
  const upgradeKey = inferStrategyUpgradeKey(record);
  if (upgradeKey === "horizonReturnReview") {
    const tracking = readJson(RECOMMENDATION_TRACKING_FILE, { records: {} });
    let updated = 0;
    for (const item of Object.values(tracking.records || {})) {
      item.performance ||= {};
      item.performance.horizonReturns = calculateHorizonReturns(item);
      updated += 1;
    }
    writeJson(RECOMMENDATION_TRACKING_FILE, tracking);
    if (snapshot.recommendationTracking?.records) {
      for (const item of snapshot.recommendationTracking.records) {
        item.performance ||= {};
        item.performance.horizonReturns = calculateHorizonReturns(item);
      }
    }
    state.effects.horizonReturnReview = {
      active: true,
      appliedAt: record.decidedAt,
      horizons: [1, 3, 5, 10, 20],
      updatedRecords: updated
    };
    snapshot.strategyUpgradeEffects ||= {};
    snapshot.strategyUpgradeEffects.horizonReturnReview = state.effects.horizonReturnReview;
    writeSnapshot(applyStrategyUpgradeState(snapshot, state));
    return `已启用后续收益回看，并为 ${updated} 条推荐追踪记录补充 1/3/5/10/20 日表现字段。`;
  }
  if (upgradeKey === "riskRewardGateReview") {
    const logs = readJson(STRATEGY_LOG_FILE, []);
    const recent = logs.slice(-5).map(entry => {
      const total = Number(entry.candidateCount || 0);
      const blocked = Number(entry.states?.["暂不交易"] || entry.states?.["鏆備笉浜ゆ槗"] || 0);
      return {
        generatedAtChina: entry.generatedAtChina,
        blockedRatio: total ? round((blocked / total) * 100, 1) : null,
        total,
        blocked
      };
    });
    const triggered = recent.length >= 5 && recent.every(item => Number(item.blockedRatio) > 75);
    state.effects.riskRewardGateReview = {
      active: true,
      appliedAt: record.decidedAt,
      rule: "连续5次刷新暂不交易占比高于75%时，触发风险收益比/趋势阶段门槛复核。",
      recent,
      triggered
    };
    snapshot.strategyUpgradeEffects ||= {};
    snapshot.strategyUpgradeEffects.riskRewardGateReview = state.effects.riskRewardGateReview;
    snapshot.strategyReview ||= {};
    snapshot.strategyReview.observations ||= [];
    snapshot.strategyReview.observations.push(triggered
      ? "风险收益比/趋势阶段门槛复核已触发：最近5次刷新暂不交易占比均高于75%，需要进入下一轮参数调整讨论。"
      : "风险收益比/趋势阶段门槛复核已启用：当前仅监控，不立即放松交易门槛。");
    writeSnapshot(applyStrategyUpgradeState(snapshot, state));
    return triggered
      ? "已启用门槛复核，并检测到最近5次刷新均超过75%，后续应进入参数调整讨论。"
      : "已启用门槛复核监控；当前不直接修改选股阈值，等待连续样本触发。";
  }
  throw new Error(`没有找到可执行的策略升级处理器：${record.title || record.id || upgradeKey || "unknown"}`);
}

function rollbackStrategyUpgradeEffect(record, state) {
  const snapshot = readJson(SNAPSHOT_FILE, null);
  if (!snapshot) throw new Error("snapshot missing; cannot rollback strategy upgrade");
  state.effects ||= {};
  const upgradeKey = inferStrategyUpgradeKey(record);
  if (upgradeKey === "horizonReturnReview") {
    delete state.effects.horizonReturnReview;
    const tracking = readJson(RECOMMENDATION_TRACKING_FILE, { records: {} });
    let cleaned = 0;
    for (const item of Object.values(tracking.records || {})) {
      if (item.performance?.horizonReturns) {
        delete item.performance.horizonReturns;
        cleaned += 1;
      }
    }
    writeJson(RECOMMENDATION_TRACKING_FILE, tracking);
    if (snapshot.recommendationTracking?.records) {
      for (const item of snapshot.recommendationTracking.records) {
        if (item.performance?.horizonReturns) delete item.performance.horizonReturns;
      }
    }
    if (snapshot.strategyUpgradeEffects) delete snapshot.strategyUpgradeEffects.horizonReturnReview;
    writeSnapshot(applyStrategyUpgradeState(snapshot, state));
    return `已回退后续收益回看升级，并清理 ${cleaned} 条推荐追踪记录中的 1/3/5/10/20 日回看字段。`;
  }
  if (upgradeKey === "riskRewardGateReview") {
    delete state.effects.riskRewardGateReview;
    if (snapshot.strategyUpgradeEffects) delete snapshot.strategyUpgradeEffects.riskRewardGateReview;
    writeSnapshot(applyStrategyUpgradeState(snapshot, state));
    return "已回退风险收益比/趋势阶段门槛复核升级；恢复为原有复盘观察逻辑。";
  }
  throw new Error(`没有找到可执行的策略回退处理器：${record.title || record.id || upgradeKey || "unknown"}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString();
      if (body.length > 1024 * 1024) reject(new Error("request body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function updateSnapshotTrackingStatus(code, active, record) {
  const snapshot = readJson(SNAPSHOT_FILE, null);
  if (!snapshot?.recommendationTracking?.records) return;
  const target = snapshot.recommendationTracking.records.find(item => item.code === code);
  if (!target) return;
  target.active = active;
  if (active) {
    target.stoppedAt = null;
    target.stoppedReason = "";
  } else {
    target.stoppedAt = record.decidedAt;
    target.stoppedReason = record.reason || "已确认剔除";
  }
  snapshot.recommendationTracking.active = snapshot.recommendationTracking.records.filter(item => item.active).length;
  snapshot.recommendationTracking.stopped = snapshot.recommendationTracking.records.filter(item => !item.active).length;
  writeJson(SNAPSHOT_FILE, snapshot);
  const jsFile = path.join(ROOT, "data", "trading-assistant.js");
  writeJson(jsFile, snapshot);
  fs.writeFileSync(jsFile, `window.TRADING_ASSISTANT_DATA = ${JSON.stringify(snapshot, null, 2)};\n`, "utf8");
}

async function updateRemovalState(req, res, mode) {
  try {
    const body = JSON.parse(await readBody(req) || "{}");
    const code = String(body.code || "").trim();
    if (!/^\d{6}$/.test(code)) {
      send(res, 400, JSON.stringify({ ok: false, error: "invalid code" }));
      return;
    }
    const preSync = await runDurableStateSync("restore");
    const state = readJson(REMOVAL_STATE_FILE, { confirmedRemoved: {}, keepTracking: {}, history: [] });
    state.confirmedRemoved ||= {};
    state.keepTracking ||= {};
    state.history ||= [];
    const record = {
      code,
      name: body.name || "",
      reason: body.reason || "",
      decidedAt: new Date().toISOString()
    };
    if (mode === "confirm") {
      state.confirmedRemoved[code] = record;
      delete state.keepTracking[code];
      state.history.push({ ...record, action: "confirmRemoval" });
      const tracking = readJson(RECOMMENDATION_TRACKING_FILE, { records: {} });
      if (tracking.records?.[code]) {
        tracking.records[code].active = false;
        tracking.records[code].stoppedAt = record.decidedAt;
        tracking.records[code].stoppedReason = record.reason || "已确认剔除";
        writeJson(RECOMMENDATION_TRACKING_FILE, tracking);
      }
      updateSnapshotTrackingStatus(code, false, record);
    } else {
      state.keepTracking[code] = record;
      delete state.confirmedRemoved[code];
      state.history.push({ ...record, action: "keepTracking" });
      const tracking = readJson(RECOMMENDATION_TRACKING_FILE, { records: {} });
      if (tracking.records?.[code]) {
        tracking.records[code].active = true;
        tracking.records[code].stoppedAt = null;
        tracking.records[code].stoppedReason = "";
        writeJson(RECOMMENDATION_TRACKING_FILE, tracking);
      }
      updateSnapshotTrackingStatus(code, true, record);
    }
    state.history = state.history.slice(-500);
    writeJson(REMOVAL_STATE_FILE, state);
    const cloudSync = await runDurableStateSync("publish");
    send(res, 200, JSON.stringify({ ok: true, state, preSync, cloudSync }));
  } catch (error) {
    send(res, 500, JSON.stringify({ ok: false, error: String(error.message || error) }));
  }
}

async function confirmStrategyUpgrade(req, res) {
  try {
    const body = JSON.parse(await readBody(req) || "{}");
    const title = String(body.title || "").trim();
    const upgradeKey = inferStrategyUpgradeKey(body);
    if (!title && !upgradeKey) {
      send(res, 400, JSON.stringify({ ok: false, error: "missing upgrade title or key" }));
      return;
    }
    const preSync = await runDurableStateSync("restore");
    const record = {
      id: body.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      upgradeKey,
      title,
      reason: body.reason || "",
      proposedChange: body.proposedChange || "",
      sourceRefresh: body.sourceRefresh || "",
      decidedAt: new Date().toISOString(),
      status: "confirmed"
    };
    const state = readJson(STRATEGY_UPGRADE_STATE_FILE, { confirmed: [], history: [] });
    state.confirmed ||= [];
    state.history ||= [];
    state.confirmed = state.confirmed.filter(item => !sameStrategyUpgrade(item, record));
    const executionMessage = executeStrategyUpgrade(record, state);
    record.status = "applied";
    record.executionMessage = executionMessage;
    record.executionError = "";
    state.confirmed.push(record);
    state.history.push({ ...record, action: "confirmStrategyUpgrade" });
    state.confirmed = state.confirmed.slice(-200);
    state.history = state.history.slice(-500);
    writeJson(STRATEGY_UPGRADE_STATE_FILE, state);
    const snapshot = readJson(SNAPSHOT_FILE, null);
    if (snapshot) {
      snapshot.strategyUpgradeState = state;
      snapshot.strategyReview ||= {};
      snapshot.strategyReview.confirmedUpgrades = state.confirmed;
      for (const suggestion of snapshot.strategyReview.suggestions || []) {
        if (sameStrategyUpgrade(suggestion, record)) suggestion.status = "已确认升级，等待策略实现";
      }
      applyStrategyUpgradeState(snapshot, state);
      writeSnapshot(snapshot);
    }
    const cloudSync = await runDurableStateSync("publish");
    send(res, 200, JSON.stringify({ ok: true, record, state, message: executionMessage, preSync, cloudSync }));
  } catch (error) {
    send(res, 500, JSON.stringify({ ok: false, error: String(error.message || error) }));
  }
}

async function rollbackStrategyUpgrade(req, res) {
  try {
    const body = JSON.parse(await readBody(req) || "{}");
    const title = String(body.title || "").trim();
    const id = String(body.id || "").trim();
    const upgradeKey = inferStrategyUpgradeKey(body);
    if (!title && !id && !upgradeKey) {
      send(res, 400, JSON.stringify({ ok: false, error: "missing upgrade title, id or key" }));
      return;
    }
    const preSync = await runDurableStateSync("restore");
    const state = readJson(STRATEGY_UPGRADE_STATE_FILE, { confirmed: [], history: [] });
    state.confirmed ||= [];
    state.history ||= [];
    const target = { id, title, upgradeKey };
    const removed = state.confirmed.filter(item => (id && item.id === id) || sameStrategyUpgrade(item, target));
    state.confirmed = state.confirmed.filter(item => !((id && item.id === id) || sameStrategyUpgrade(item, target)));
    const record = {
      id: id || removed[0]?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      upgradeKey: upgradeKey || inferStrategyUpgradeKey(removed[0]),
      title: title || removed[0]?.title || "",
      reason: body.reason || removed[0]?.reason || "",
      proposedChange: body.proposedChange || removed[0]?.proposedChange || "",
      sourceRefresh: body.sourceRefresh || removed[0]?.sourceRefresh || "",
      decidedAt: new Date().toISOString(),
      status: "rolledBack"
    };
    const executionMessage = rollbackStrategyUpgradeEffect(record, state);
    record.executionMessage = executionMessage;
    record.executionError = "";
    state.history.push({ ...record, action: "rollbackStrategyUpgrade" });
    state.history = state.history.slice(-500);
    writeJson(STRATEGY_UPGRADE_STATE_FILE, state);
    const snapshot = readJson(SNAPSHOT_FILE, null);
    if (snapshot) {
      applyStrategyUpgradeState(snapshot, state);
      writeSnapshot(snapshot);
    }
    const cloudSync = await runDurableStateSync("publish");
    send(res, 200, JSON.stringify({ ok: true, record, state, message: executionMessage, preSync, cloudSync }));
  } catch (error) {
    send(res, 500, JSON.stringify({ ok: false, error: String(error.message || error) }));
  }
}

function runRefresh() {
  if (currentRefreshPromise) return currentRefreshPromise;
  currentRefreshPromise = new Promise((resolve, reject) => {
    refreshing = true;
    lastRefreshError = null;
    lastRefreshStartedAt = new Date().toISOString();
    lastRefreshOutput = "";
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "refresh-trading-assistant.js")], {
      cwd: ROOT,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      stderr += "\nrefresh timeout after 12 minutes";
      child.kill();
    }, 12 * 60 * 1000);
    child.on("close", code => {
      clearTimeout(timer);
      refreshing = false;
      currentRefreshPromise = null;
      lastRefresh = new Date().toISOString();
      lastRefreshOutput = (stdout || stderr || "").slice(-4000);
      if (code === 0) {
        runStrategyReview().finally(() => resolve({ stdout, stderr, lastRefresh }));
      } else {
        lastRefreshError = stderr || stdout || `refresh exited with ${code}`;
        runStrategyReview().finally(() => reject(new Error(lastRefreshError)));
      }
    });
  });
  return currentRefreshPromise;
}

function runStrategyReview() {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "update-strategy-review.js")], {
      cwd: ROOT,
      windowsHide: true
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }
  if (url.pathname === "/api/status") {
    send(res, 200, JSON.stringify({ refreshing, lastRefresh, lastRefreshStartedAt, lastRefreshError, lastRefreshOutput }));
    return;
  }
  if (url.pathname === "/api/snapshot") {
    const file = path.join(ROOT, "data", "trading-assistant.json");
    if (!fs.existsSync(file)) {
      send(res, 404, JSON.stringify({ error: "还没有交易助理数据，请先点击刷新。" }));
      return;
    }
    send(res, 200, fs.readFileSync(file, "utf8"));
    return;
  }
  if (url.pathname === "/api/refresh" && req.method === "POST") {
    runRefresh().catch(() => {});
    send(res, 202, JSON.stringify({ ok: true, refreshing: true, startedAt: lastRefreshStartedAt }));
    return;
  }
  if (url.pathname === "/api/removal/confirm" && req.method === "POST") {
    await updateRemovalState(req, res, "confirm");
    return;
  }
  if (url.pathname === "/api/removal/keep" && req.method === "POST") {
    await updateRemovalState(req, res, "keep");
    return;
  }
  if (url.pathname === "/api/strategy/confirm-upgrade" && req.method === "POST") {
    await confirmStrategyUpgrade(req, res);
    return;
  }
  if (url.pathname === "/api/strategy/rollback-upgrade" && req.method === "POST") {
    await rollbackStrategyUpgrade(req, res);
    return;
  }

  const requested = decodeURIComponent(url.pathname === "/" || url.pathname === "/index.html" ? "/trading-assistant.html" : url.pathname);
  const file = path.normalize(path.join(ROOT, requested));
  if (!file.startsWith(ROOT)) {
    send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  send(res, 200, fs.readFileSync(file), contentTypes[path.extname(file)] || "application/octet-stream");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Trading assistant server running at http://127.0.0.1:${PORT}/`);
});
