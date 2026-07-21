const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8765);
const REMOVAL_STATE_FILE = path.join(ROOT, "data", "trading-assistant-removal-state.json");
const RECOMMENDATION_TRACKING_FILE = path.join(ROOT, "data", "trading-assistant-recommendation-tracking.json");
const STRATEGY_UPGRADE_STATE_FILE = path.join(ROOT, "data", "trading-assistant-strategy-upgrade-state.json");
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

function applyStrategyUpgradeState(snapshot, state) {
  if (!snapshot) return snapshot;
  const confirmed = state?.confirmed || [];
  snapshot.strategyUpgradeState = state || { confirmed: [], history: [] };
  snapshot.strategyReview ||= {};
  snapshot.strategyReview.confirmedUpgrades = confirmed;
  for (const suggestion of snapshot.strategyReview.suggestions || []) {
    const record = confirmed.find(item => item.title === suggestion.title);
    if (record) {
      suggestion.status = "已升级";
      suggestion.confirmedAt = record.decidedAt || "";
    } else if (suggestion.status === "已升级" || suggestion.status === "confirmed") {
      suggestion.status = "待你确认";
      delete suggestion.confirmedAt;
    }
  }
  return snapshot;
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
    send(res, 200, JSON.stringify({ ok: true, state }));
  } catch (error) {
    send(res, 500, JSON.stringify({ ok: false, error: String(error.message || error) }));
  }
}

async function confirmStrategyUpgrade(req, res) {
  try {
    const body = JSON.parse(await readBody(req) || "{}");
    const title = String(body.title || "").trim();
    if (!title) {
      send(res, 400, JSON.stringify({ ok: false, error: "missing upgrade title" }));
      return;
    }
    const record = {
      id: body.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
    state.confirmed = state.confirmed.filter(item => item.title !== title);
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
        if (suggestion.title === title) suggestion.status = "已确认升级，等待策略实现";
      }
      applyStrategyUpgradeState(snapshot, state);
      writeSnapshot(snapshot);
    }
    send(res, 200, JSON.stringify({ ok: true, record, state }));
  } catch (error) {
    send(res, 500, JSON.stringify({ ok: false, error: String(error.message || error) }));
  }
}

async function rollbackStrategyUpgrade(req, res) {
  try {
    const body = JSON.parse(await readBody(req) || "{}");
    const title = String(body.title || "").trim();
    const id = String(body.id || "").trim();
    if (!title && !id) {
      send(res, 400, JSON.stringify({ ok: false, error: "missing upgrade title or id" }));
      return;
    }
    const state = readJson(STRATEGY_UPGRADE_STATE_FILE, { confirmed: [], history: [] });
    state.confirmed ||= [];
    state.history ||= [];
    const removed = state.confirmed.filter(item => (id && item.id === id) || (title && item.title === title));
    state.confirmed = state.confirmed.filter(item => !((id && item.id === id) || (title && item.title === title)));
    const record = {
      id: id || removed[0]?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title: title || removed[0]?.title || "",
      reason: body.reason || removed[0]?.reason || "",
      proposedChange: body.proposedChange || removed[0]?.proposedChange || "",
      sourceRefresh: body.sourceRefresh || removed[0]?.sourceRefresh || "",
      decidedAt: new Date().toISOString(),
      status: "rolledBack"
    };
    state.history.push({ ...record, action: "rollbackStrategyUpgrade" });
    state.history = state.history.slice(-500);
    writeJson(STRATEGY_UPGRADE_STATE_FILE, state);
    const snapshot = readJson(SNAPSHOT_FILE, null);
    if (snapshot) {
      applyStrategyUpgradeState(snapshot, state);
      writeSnapshot(snapshot);
    }
    send(res, 200, JSON.stringify({ ok: true, record, state }));
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
