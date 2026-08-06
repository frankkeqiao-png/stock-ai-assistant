const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  buildPresentation,
  finalizeArchive,
  mergeRecord,
  readArchive,
  writeArchive
} = require("./recommendation-history");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const MODULE_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(MODULE_ROOT, "data");
const TRACKING_FILE = path.join(DATA_DIR, "trading-assistant-recommendation-tracking.json");
const SNAPSHOT_FILE = path.join(DATA_DIR, "trading-assistant.json");
const STATE_BRANCH = "trading-assistant-state";
const TRACKING_PATH = "modules/trading-assistant/data/trading-assistant-recommendation-tracking.json";

function gitBinary() {
  if (process.env.GIT_BINARY && fs.existsSync(process.env.GIT_BINARY)) return process.env.GIT_BINARY;
  const bundled = path.resolve(path.dirname(process.execPath), "..", "..", "native", "git", "cmd", "git.exe");
  return process.platform === "win32" && fs.existsSync(bundled) ? bundled : "git";
}

function runGit(args) {
  const result = spawnSync(gitBinary(), args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 50 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || result.error?.message || "git command failed").trim());
  }
  return String(result.stdout || "").trim();
}

function readJson(file, fallback) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

function writeSnapshot(snapshot) {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), "utf8");
  fs.writeFileSync(path.join(DATA_DIR, "trading-assistant.js"), `window.TRADING_ASSISTANT_DATA = ${JSON.stringify(snapshot, null, 2)};\n`, "utf8");
}

function main() {
  // The explicit refspec is intentional: it makes the history available on a
  // clean CI runner as refs/remotes/origin/trading-assistant-state.
  runGit(["fetch", "origin", `+refs/heads/${STATE_BRANCH}:refs/remotes/origin/${STATE_BRANCH}`, "--prune"]);
  const commits = runGit(["log", "--reverse", "--format=%H", `origin/${STATE_BRANCH}`, "--", TRACKING_PATH])
    .split(/\r?\n/)
    .filter(Boolean);
  if (!commits.length) throw new Error("no historical recommendation tracking commits were found");

  const archive = readArchive();
  let importedSnapshots = 0;
  let importedRecords = 0;
  for (const commit of commits) {
    try {
      const content = runGit(["show", `${commit}:${TRACKING_PATH}`]);
      const historical = JSON.parse(content);
      for (const record of Object.values(historical.records || {})) {
        mergeRecord(archive, record);
        importedRecords += 1;
      }
      importedSnapshots += 1;
    } catch {
      // The file did not exist in this early state-branch commit.
    }
  }

  const currentTracking = readJson(TRACKING_FILE, { records: {} });
  for (const record of Object.values(currentTracking.records || {})) mergeRecord(archive, record);
  const snapshot = readJson(SNAPSHOT_FILE, null);
  const updatedAt = snapshot?.generatedAt || currentTracking.updatedAt || new Date().toISOString();
  const updatedAtChina = snapshot?.generatedAtChina || currentTracking.updatedAtChina || "";
  finalizeArchive(archive, { updatedAt, updatedAtChina });
  writeArchive(archive);

  if (snapshot) {
    snapshot.recommendationTracking = buildPresentation(archive, updatedAtChina);
    snapshot.historyRecovery = {
      recoveredAt: new Date().toISOString(),
      stateBranch: STATE_BRANCH,
      importedSnapshots,
      recordsInArchive: Object.keys(archive.records || {}).length,
      note: "Historical recommendation records were rebuilt from the durable state branch."
    };
    writeSnapshot(snapshot);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    commits: importedSnapshots,
    importedRecords,
    archiveRecords: Object.keys(archive.records || {}).length,
    calendarDays: Object.keys(archive.calendar || {}).length
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.message || error) })}\n`);
  process.exit(1);
}
