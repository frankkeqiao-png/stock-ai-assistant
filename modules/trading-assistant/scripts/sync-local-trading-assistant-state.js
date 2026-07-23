const path = require("path");
const { spawnSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const SYNC_SCRIPT = path.join(__dirname, "sync-trading-assistant-state.js");
const BUILD_SCRIPT = path.join(PROJECT_ROOT, "scripts", "build-github-pages.js");

function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180000
  });
  const output = String(result.stdout || result.stderr || "").trim();
  if (result.error || result.status !== 0) throw new Error(output || result.error?.message || `${path.basename(script)} failed`);
  return output;
}

try {
  const sync = run(SYNC_SCRIPT, ["--mode", "restore", "--allow-missing"]);
  const build = run(BUILD_SCRIPT);
  console.log(JSON.stringify({ ok: true, sync, build }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error.message || error) }));
  process.exit(1);
}
