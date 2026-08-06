const fs = require("fs");
const path = require("path");

const DATA_DIR = path.resolve(__dirname, "..", "data");
const ARCHIVE_FILE = path.join(DATA_DIR, "trading-assistant-recommendation-archive.json");

function readJson(file, fallback) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

function emptyArchive() {
  return {
    version: "recommendation-archive-v1",
    updatedAt: "",
    updatedAtChina: "",
    records: {},
    calendar: {}
  };
}

function readArchive() {
  const archive = readJson(ARCHIVE_FILE, emptyArchive());
  archive.version ||= "recommendation-archive-v1";
  archive.records ||= {};
  archive.calendar ||= {};
  return archive;
}

function writeArchive(archive) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(archive, null, 2), "utf8");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function dateOnly(value) {
  const text = String(value || "");
  const matched = text.match(/\d{4}[-/]\d{2}[-/]\d{2}/);
  return matched ? matched[0].replace(/\//g, "-") : "";
}

function recordUpdatedAt(record) {
  const recommendations = record?.recommendations || [];
  return String(record?.lastSeenAt || recommendations[recommendations.length - 1]?.at || record?.firstRecommendedAt || "");
}

function recommendationKey(event) {
  return [event?.at || "", event?.date || "", event?.price ?? "", event?.state || "", event?.score ?? ""].join("|");
}

function mergeRecommendations(existing, incoming) {
  const seen = new Map();
  for (const event of [...(existing || []), ...(incoming || [])]) {
    if (!event) continue;
    seen.set(recommendationKey(event), clone(event));
  }
  return [...seen.values()].sort((a, b) => {
    const left = String(a.at || a.date || "");
    const right = String(b.at || b.date || "");
    return left.localeCompare(right);
  });
}

function mergePriceHistory(existing, incoming) {
  const points = new Map();
  for (const point of [...(existing || []), ...(incoming || [])]) {
    if (!point?.date) continue;
    const current = points.get(point.date);
    if (!current || String(point.at || "") >= String(current.at || "")) points.set(point.date, clone(point));
  }
  return [...points.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function mergeRecord(archive, record) {
  if (!record?.code) return null;
  const old = archive.records[record.code];
  const sourceIsNewer = !old || recordUpdatedAt(record) >= recordUpdatedAt(old);
  const preferred = sourceIsNewer ? record : old;
  const secondary = sourceIsNewer ? old : record;
  const merged = {
    ...(secondary ? clone(secondary) : {}),
    ...clone(preferred),
    code: record.code,
    recommendations: mergeRecommendations(old?.recommendations, record.recommendations),
    priceHistory: mergePriceHistory(old?.priceHistory, record.priceHistory)
  };

  const oldFirst = String(old?.firstDate || old?.firstRecommendedAt || "");
  const newFirst = String(record.firstDate || record.firstRecommendedAt || "");
  if (old && oldFirst && (!newFirst || oldFirst < newFirst)) {
    for (const key of ["firstRecommendedAt", "firstRecommendedAtChina", "firstDate", "firstPrice", "firstState", "firstScore", "firstLayer", "firstReason", "sector", "initialPlan"]) {
      if (old[key] !== undefined) merged[key] = clone(old[key]);
    }
  }
  archive.records[record.code] = merged;
  return merged;
}

function rebuildCalendar(archive) {
  const calendar = {};
  for (const record of Object.values(archive.records || {})) {
    for (const event of record.recommendations || []) {
      const date = dateOnly(event.date || event.atChina || event.at);
      if (!date) continue;
      calendar[date] ||= [];
      if (!calendar[date].includes(record.code)) calendar[date].push(record.code);
    }
  }
  for (const codes of Object.values(calendar)) codes.sort();
  archive.calendar = calendar;
  return calendar;
}

function finalizeArchive(archive, { updatedAt = "", updatedAtChina = "" } = {}) {
  archive.version = "recommendation-archive-v1";
  archive.updatedAt = updatedAt || archive.updatedAt || "";
  archive.updatedAtChina = updatedAtChina || archive.updatedAtChina || "";
  rebuildCalendar(archive);
  return archive;
}

function recordListForPresentation(archive) {
  return Object.values(archive.records || {}).sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return String(b.lastSeenAt || b.firstRecommendedAt || "").localeCompare(String(a.lastSeenAt || a.firstRecommendedAt || ""));
  });
}

function buildPresentation(archive, updatedAtChina = "") {
  const records = recordListForPresentation(archive);
  return {
    updatedAtChina: updatedAtChina || archive.updatedAtChina,
    archiveRetention: "永久追加保存（不因页面展示或常规刷新删除）",
    total: records.length,
    active: records.filter(record => record.active).length,
    stopped: records.filter(record => !record.active).length,
    calendar: Object.fromEntries(Object.entries(archive.calendar || {}).sort((a, b) => b[0].localeCompare(a[0]))),
    records: records.map(record => ({
      code: record.code,
      name: record.name,
      sector: record.sector,
      active: record.active,
      firstDate: record.firstDate,
      firstPrice: record.firstPrice,
      firstState: record.firstState,
      firstScore: record.firstScore,
      firstLayer: record.firstLayer,
      firstReason: record.firstReason,
      currentPrice: record.currentPrice,
      currentState: record.currentState,
      currentScore: record.currentScore,
      currentLayer: record.currentLayer,
      currentLayerReason: record.currentLayerReason,
      lastSeenAtChina: record.lastSeenAtChina,
      stoppedAt: record.stoppedAt,
      stoppedReason: record.stoppedReason,
      initialPlan: record.initialPlan,
      lastPlan: record.lastPlan,
      performance: record.performance,
      priceHistory: record.priceHistory,
      recommendations: record.recommendations
    }))
  };
}

module.exports = {
  ARCHIVE_FILE,
  clone,
  buildPresentation,
  emptyArchive,
  finalizeArchive,
  mergeRecord,
  readArchive,
  recordListForPresentation,
  writeArchive
};
