const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const htmlPath = path.join(ROOT, "index.html");
const snapshotPath = path.join(ROOT, "data", "snapshot.js");
const auditPath = path.join(ROOT, "data", "data-audit.json");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

const html = read(htmlPath);
const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");
new Function(scripts);

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(read(snapshotPath), ctx);
const d = ctx.window.STOCK_ASSISTANT_DATA;
if (!d) throw new Error("snapshot.js 未生成 window.STOCK_ASSISTANT_DATA");
if (!d.candidates?.length) throw new Error("候选池为空");
if (!d.audit?.candidatesWithFinancial) throw new Error("候选股财报覆盖为空");
if (!d.audit?.candidatesWithKline) throw new Error("候选股K线覆盖为空");
if (!d.audit?.candidatesWithCompanyProfile) throw new Error("候选股公司F10覆盖为空");
if (!d.audit?.candidatesWithAnnouncementPdf) throw new Error("候选股公告PDF覆盖为空");

const audit = JSON.parse(read(auditPath));
console.log(JSON.stringify({
  html: "OK",
  snapshot: "OK",
  version: d.version,
  dataScope: d.dataScope,
  candidates: d.candidates.length,
  financialCoverage: `${d.audit.candidatesWithFinancial}/${d.audit.candidates}`,
  announcementCoverage: `${d.audit.candidatesWithAnnouncements}/${d.audit.candidates}`,
  klineCoverage: `${d.audit.candidatesWithKline}/${d.audit.candidates}`,
  minuteKlineCoverage: `${d.audit.candidatesWithMinuteKline}/${d.audit.candidates}`,
  companyProfileCoverage: `${d.audit.candidatesWithCompanyProfile}/${d.audit.candidates}`,
  announcementPdfCoverage: `${d.audit.candidatesWithAnnouncementPdf}/${d.audit.candidates}`,
  sectorSource: d.audit.sectorSource,
  sourceFailures: audit.failures.length
}, null, 2));
