const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "data", "alternative-source-validation.json");
const samples = ["603501", "000858", "300750"];

async function main() {
  const results = [];
  for (const code of samples) {
    results.push(await test(`新浪实时行情 ${code}`, () => fetchText(`https://hq.sinajs.cn/list=${sinaSymbol(code)}`, "https://finance.sina.com.cn/"), text => text.includes("hq_str_") && text.includes(",")));
    results.push(await test(`腾讯实时行情 ${code}`, () => fetchText(`https://qt.gtimg.cn/q=${tencentSymbol(code)}`, "https://gu.qq.com/"), text => text.includes("~") && text.includes(code)));
    results.push(await test(`新浪日K ${code}`, () => fetchJson(`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sinaSymbol(code)}&scale=240&ma=no&datalen=30`, "https://finance.sina.com.cn/"), json => Array.isArray(json) && json.length > 5));
    results.push(await test(`腾讯日K ${code}`, () => fetchJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tencentSymbol(code)},day,,,30,qfq`, "https://gu.qq.com/"), json => {
      const key = tencentSymbol(code);
      return Array.isArray(json?.data?.[key]?.qfqday || json?.data?.[key]?.day);
    }));
    results.push(await test(`腾讯分钟K ${code}`, () => fetchJson(`https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${tencentSymbol(code)},m30,,80`, "https://gu.qq.com/"), json => {
      const key = tencentSymbol(code);
      return Array.isArray(json?.data?.[key]?.m30);
    }));
    results.push(await test(`巨潮公告 ${code}`, () => fetchCninfoAnnouncements(code), json => Array.isArray(json?.announcements) && json.announcements.length > 0));
    results.push(await test(`东方财富实时资金字段 ${code}`, () => fetchJsonViaCurl(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secid(code)}&fields=f12,f14,f2,f3,f6,f8,f9,f23,f62,f184`), json => Array.isArray(json?.data?.diff) && json.data.diff.length === 1 && json.data.diff[0].f62 !== undefined));
  }

  results.push(await test("新浪板块节点", () => fetchText("https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodes", "https://vip.stock.finance.sina.com.cn/"), text => text.includes("\\u884c\\u60c5\\u4e2d\\u5fc3") || text.includes("行情中心") || text.includes("\\u7533\\u4e07") || text.includes("申万")));
  results.push(await test("新浪半导体板块成分", () => fetchText("https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=1&num=20&sort=symbol&asc=1&node=chgn_700458&symbol=&_s_r_a=init", "https://vip.stock.finance.sina.com.cn/"), text => text.includes("symbol") && text.includes("trade")));

  const output = {
    generatedAt: new Date().toISOString(),
    summary: {
      total: results.length,
      ok: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length
    },
    results
  };
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), "utf8");
  console.log(JSON.stringify(output.summary, null, 2));
}

async function test(name, fn, check) {
  const start = Date.now();
  try {
    const data = await fn();
    const ok = !!check(data);
    return { name, ok, elapsedMs: Date.now() - start, sample: sampleOf(data) };
  } catch (error) {
    return { name, ok: false, elapsedMs: Date.now() - start, error: String(error.message || error) };
  }
}

async function fetchText(url, referer) {
  const res = await fetch(url, { headers: { "referer": referer, "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer.toString("utf8");
}

async function fetchJson(url, referer) {
  const text = await fetchText(url, referer);
  return JSON.parse(text);
}

async function fetchCninfoAnnouncements(code) {
  const orgId = await fetchCninfoOrgId(code);
  const body = new URLSearchParams({
    stock: `${code},${orgId}`,
    tabName: "fulltext",
    pageSize: "5",
    pageNum: "1",
    column: "szse",
    category: "",
    plate: "",
    seDate: "",
    searchkey: "",
    secid: "",
    sortName: "",
    sortType: "",
    isHLtitle: "true"
  });
  const res = await fetch("http://www.cninfo.com.cn/new/hisAnnouncement/query", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "referer": "http://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure/list/search",
      "user-agent": "Mozilla/5.0"
    },
    body
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.json();
}

let cninfoStockList = null;

async function fetchCninfoOrgId(code) {
  if (!cninfoStockList) {
    const json = await fetchJson("http://www.cninfo.com.cn/new/data/szse_stock.json", "http://www.cninfo.com.cn/new/index");
    cninfoStockList = Array.isArray(json?.stockList) ? json.stockList : [];
  }
  const row = cninfoStockList.find(item => item.code === code);
  if (!row?.orgId) throw new Error(`cninfo orgId not found for ${code}`);
  return row.orgId;
}

function fetchJsonViaCurl(url) {
  const text = execFileSync("curl.exe", ["-L", "--retry", "2", "--retry-delay", "1", "--connect-timeout", "10", "--max-time", "25", "-sS", "-H", "Referer: https://quote.eastmoney.com/", "-H", "User-Agent: Mozilla/5.0", url], { encoding: "utf8", timeout: 35000 });
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(start >= 0 && end >= start ? text.slice(start, end + 1) : text);
}

function sinaSymbol(code) {
  return `${code.startsWith("6") ? "sh" : "sz"}${code}`;
}

function tencentSymbol(code) {
  return `${code.startsWith("6") ? "sh" : "sz"}${code}`;
}

function secid(code) {
  return `${code.startsWith("6") ? "1" : "0"}.${code}`;
}

function sampleOf(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return text.slice(0, 180);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
