const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const moduleRoot = path.join(root, "modules", "trading-assistant");
const dist = path.join(root, "dist");

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

fs.copyFileSync(path.join(moduleRoot, "trading-assistant.html"), path.join(dist, "trading-assistant.html"));
copyDir(path.join(moduleRoot, "data"), path.join(dist, "data"));
write(path.join(dist, ".nojekyll"), "");
write(path.join(dist, "index.html"), `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="0; url=trading-assistant.html" />
  <title>股票 AI 决策助手</title>
</head>
<body>
  <p>正在打开交易助理页面...</p>
  <p><a href="trading-assistant.html">如果没有自动跳转，点击这里进入交易助理</a></p>
  <script>location.replace("trading-assistant.html");</script>
</body>
</html>
`);

const snapshot = JSON.parse(fs.readFileSync(path.join(moduleRoot, "data", "trading-assistant.json"), "utf8"));
console.log(JSON.stringify({
  dist,
  generatedAtChina: snapshot.generatedAtChina,
  candidates: snapshot.candidates?.length || 0,
  activeTracking: snapshot.recommendationTracking?.active || 0,
  failures: snapshot.audit?.failures?.length || 0
}, null, 2));
