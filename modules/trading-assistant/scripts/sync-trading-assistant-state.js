const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const MODULE_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(MODULE_ROOT, "data");
const STATE_BRANCH = "trading-assistant-state";
const TEMP_BRANCH = "trading-assistant-state-publish";
const WORKTREE_DIR = path.join(PROJECT_ROOT, ".trading-state-worktree");
const DATA_RELATIVE_DIR = path.join("modules", "trading-assistant", "data");

// These files describe user decisions and the assistant's accumulated history.
// Market caches are deliberately excluded because they can be regenerated.
const DURABLE_FILES = [
  "trading-assistant.json",
  "trading-assistant-recommendation-tracking.json",
  "trading-assistant-strategy-log.json",
  "trading-assistant-strategy-upgrade-state.json",
  "trading-assistant-removal-state.json"
];

function gitCommand() {
  if (process.env.GIT_BINARY && fs.existsSync(process.env.GIT_BINARY)) return process.env.GIT_BINARY;
  const bundled = path.resolve(path.dirname(process.execPath), "..", "..", "native", "git", "cmd", "git.exe");
  return process.platform === "win32" && fs.existsSync(bundled) ? bundled : "git";
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || PROJECT_ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout || 90000
  });
  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  if (result.error || result.status !== 0) {
    const error = new Error(stderr || stdout || result.error?.message || `${command} failed`);
    error.stdout = stdout;
    error.stderr = stderr;
    error.status = result.status;
    throw error;
  }
  return stdout;
}

function runGit(args, options = {}) {
  return run(gitCommand(), args, options);
}

function tryGit(args, options = {}) {
  try {
    return { ok: true, output: runGit(args, options) };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

function ensureRepository() {
  const inside = runGit(["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") throw new Error("trading assistant state sync must run inside a git repository");
}

function ensureDataDirectory() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function writeDerivedSnapshotJs() {
  const snapshotFile = path.join(DATA_DIR, "trading-assistant.json");
  if (!fs.existsSync(snapshotFile)) return;
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
  fs.writeFileSync(
    path.join(DATA_DIR, "trading-assistant.js"),
    `window.TRADING_ASSISTANT_DATA = ${JSON.stringify(snapshot, null, 2)};\n`,
    "utf8"
  );
}

function fetchStateBranch({ allowMissing = false } = {}) {
  const result = tryGit(["fetch", "origin", STATE_BRANCH, "--prune"], { timeout: 120000 });
  if (result.ok) return true;
  if (allowMissing && /couldn't find remote ref|not found|does not appear to be a git repository/i.test(result.error)) return false;
  throw new Error(`unable to fetch cloud state: ${result.error}`);
}

function hasRemoteStateBranch() {
  return tryGit(["rev-parse", "--verify", `refs/remotes/origin/${STATE_BRANCH}`]).ok;
}

function restore({ allowMissing = false } = {}) {
  ensureRepository();
  ensureDataDirectory();
  const fetched = fetchStateBranch({ allowMissing });
  if (!fetched || !hasRemoteStateBranch()) {
    return { ok: true, restored: false, branch: STATE_BRANCH, files: [], reason: "cloud state branch has not been created yet" };
  }

  const restored = [];
  for (const file of DURABLE_FILES) {
    const relative = path.posix.join(DATA_RELATIVE_DIR.replace(/\\/g, "/"), file);
    const shown = tryGit(["show", `origin/${STATE_BRANCH}:${relative}`]);
    if (!shown.ok) continue;
    fs.writeFileSync(path.join(DATA_DIR, file), `${shown.output}\n`, "utf8");
    restored.push(file);
  }
  writeDerivedSnapshotJs();
  return { ok: true, restored: restored.length > 0, branch: STATE_BRANCH, files: restored };
}

function cleanupWorktree() {
  tryGit(["worktree", "remove", "--force", WORKTREE_DIR]);
  if (fs.existsSync(WORKTREE_DIR)) fs.rmSync(WORKTREE_DIR, { recursive: true, force: true });
}

function prepareWorktree() {
  cleanupWorktree();
  const remoteExists = hasRemoteStateBranch();
  if (remoteExists) {
    runGit(["worktree", "add", "--force", "-B", TEMP_BRANCH, WORKTREE_DIR, `origin/${STATE_BRANCH}`]);
  } else {
    runGit(["worktree", "add", "--force", "-B", TEMP_BRANCH, WORKTREE_DIR, "HEAD"]);
  }
  return remoteExists;
}

function copyDurableFiles(targetDataDir) {
  fs.mkdirSync(targetDataDir, { recursive: true });
  const copied = [];
  for (const file of DURABLE_FILES) {
    const source = path.join(DATA_DIR, file);
    if (!fs.existsSync(source)) continue;
    fs.copyFileSync(source, path.join(targetDataDir, file));
    copied.push(file);
  }
  if (!copied.includes("trading-assistant.json")) {
    throw new Error("current snapshot is missing; refresh data before publishing trading state");
  }
  return copied;
}

function publish({ skipWorkflow = false } = {}) {
  ensureRepository();
  ensureDataDirectory();
  fetchStateBranch({ allowMissing: true });
  const remoteExists = prepareWorktree();
  try {
    const copied = copyDurableFiles(path.join(WORKTREE_DIR, DATA_RELATIVE_DIR));
    const relativeFiles = copied.map(file => path.posix.join(DATA_RELATIVE_DIR.replace(/\\/g, "/"), file));
    runGit(["add", "--", ...relativeFiles], { cwd: WORKTREE_DIR });
    const changed = tryGit(["diff", "--cached", "--quiet", "--", ...relativeFiles], { cwd: WORKTREE_DIR });
    if (changed.ok) {
      if (!remoteExists) {
        runGit(["push", "origin", `HEAD:refs/heads/${STATE_BRANCH}`], { cwd: WORKTREE_DIR, timeout: 120000 });
        return { ok: true, published: true, branch: STATE_BRANCH, files: copied, created: true, reason: "created cloud state branch from current baseline" };
      }
      return { ok: true, published: false, branch: STATE_BRANCH, files: copied, reason: "cloud state already matches local state" };
    }
    runGit(["config", "user.name", "Trading Assistant Local Sync"], { cwd: WORKTREE_DIR });
    runGit(["config", "user.email", "trading-assistant@local.invalid"], { cwd: WORKTREE_DIR });
    const message = skipWorkflow
      ? "chore(trading-state): persist scheduled refresh [skip trading-state-refresh]"
      : "chore(trading-state): sync durable state";
    runGit(["commit", "-m", message], { cwd: WORKTREE_DIR });
    runGit(["push", "origin", `HEAD:refs/heads/${STATE_BRANCH}`], { cwd: WORKTREE_DIR, timeout: 120000 });
    return { ok: true, published: true, branch: STATE_BRANCH, files: copied, created: !remoteExists };
  } finally {
    cleanupWorktree();
  }
}

function main() {
  const mode = process.argv.includes("--mode") ? process.argv[process.argv.indexOf("--mode") + 1] : "restore";
  const allowMissing = process.argv.includes("--allow-missing");
  const skipWorkflow = process.argv.includes("--skip-workflow");
  const result = mode === "publish" ? publish({ skipWorkflow }) : restore({ allowMissing });
  process.stdout.write(`${JSON.stringify(result)}${os.EOL}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.message || error) })}${os.EOL}`);
  process.exit(1);
}
