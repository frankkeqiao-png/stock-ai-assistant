const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SNAPSHOT_JS = path.join(DATA_DIR, "snapshot.js");
const SNAPSHOT_JSON = path.join(DATA_DIR, "snapshot.json");
const AUDIT_JSON = path.join(DATA_DIR, "data-audit.json");
const FULL_SNAPSHOT_JSON = path.join(DATA_DIR, "snapshot.full-market.json");

const EASTMONEY_FIELDS = [
  "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f12", "f14",
  "f15", "f16", "f17", "f18", "f20", "f21", "f23", "f62"
].join(",");

const audit = {
  generatedAt: new Date().toISOString(),
  sources: [],
  failures: [],
  coverage: {}
};

function round(value, digits = 2) {
  if (value === null || value === undefined || value === "-" || Number.isNaN(Number(value))) return null;
  return Number(Number(value).toFixed(digits));
}

function yi(value) {
  if (value === null || value === undefined || value === "-" || Number.isNaN(Number(value))) return null;
  return round(Number(value) / 100000000, 2);
}

function pct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return round(Number(value));
}

function todayChina() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
}

function loadFullMarketCache() {
  if (!fs.existsSync(FULL_SNAPSHOT_JSON)) return null;
  try {
    return JSON.parse(fs.readFileSync(FULL_SNAPSHOT_JSON, "utf8"));
  } catch {
    return null;
  }
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 18000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 stock-ai-assistant/0.3",
        "referer": options.referer || "https://finance.sina.com.cn/"
      }
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    if (options.encoding && options.encoding.toLowerCase() !== "utf-8") {
      const buffer = await res.arrayBuffer();
      return new TextDecoder(options.encoding).decode(buffer);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}) {
  return JSON.parse(await fetchText(url, options));
}

async function withRetry(fn, attempts = 3, delayMs = 900) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, delayMs * (i + 1)));
    }
  }
  throw lastError;
}

async function guarded(name, fn, fallback) {
  try {
    const data = await withRetry(fn);
    audit.sources.push({ name, ok: true });
    return data;
  } catch (error) {
    audit.sources.push({ name, ok: false, error: String(error.message || error) });
    audit.failures.push({ name, error: String(error.message || error) });
    return fallback;
  }
}

function eastmoneyUrl({ fsExpr, pageSize = 100, page = 1, order = 1, sort = "f3", fields = EASTMONEY_FIELDS }) {
  const params = new URLSearchParams({
    pn: String(page),
    pz: String(pageSize),
    po: String(order),
    np: "1",
    ut: "bd1d9ddb04089700cf9c27f6f7426281",
    fltt: "2",
    invt: "2",
    fid: sort,
    fs: fsExpr,
    fields
  });
  return `https://push2.eastmoney.com/api/qt/clist/get?${params.toString()}`;
}

async function fetchEastmoneyList(args) {
  const json = await fetchJson(eastmoneyUrl(args), { timeout: 45000, referer: "https://quote.eastmoney.com/" });
  return json?.data?.diff || [];
}

async function fetchEastmoneyPaged(args) {
  const pageSize = args.pageSize || 100;
  const first = await fetchJson(eastmoneyUrl({ ...args, pageSize, page: 1 }), { timeout: 45000, referer: "https://quote.eastmoney.com/" });
  const total = first?.data?.total || 0;
  const rows = [...(first?.data?.diff || [])];
  const pages = Math.ceil(total / pageSize);
  for (let page = 2; page <= pages; page += 1) {
    const json = await fetchJson(eastmoneyUrl({ ...args, pageSize, page }), { timeout: 45000, referer: "https://quote.eastmoney.com/" });
    rows.push(...(json?.data?.diff || []));
  }
  return rows;
}

function normalizeStock(row) {
  return {
    code: row.f12,
    name: row.f14,
    price: round(row.f2),
    pct: round(row.f3),
    change: round(row.f4),
    volumeHands: row.f5,
    amountYi: yi(row.f6),
    amplitude: round(row.f7),
    turnover: round(row.f8),
    pe: round(row.f9),
    volumeRatio: round(row.f10),
    high: round(row.f15),
    low: round(row.f16),
    open: round(row.f17),
    prevClose: round(row.f18),
    marketCapYi: yi(row.f20),
    floatCapYi: yi(row.f21),
    pb: round(row.f23),
    mainNetInflowYi: yi(row.f62)
  };
}

function parseSinaLines(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/var hq_str_([^=]+)="([^"]*)"/);
    if (m) rows.push({ symbol: m[1], values: m[2].split(",") });
  }
  return rows;
}

async function fetchSinaQuotes(symbols) {
  const url = `https://hq.sinajs.cn/list=${symbols.join(",")}`;
  return parseSinaLines(await fetchText(url, { referer: "https://finance.sina.com.cn/", timeout: 16000, encoding: "gbk" }));
}

const FALLBACK_WATCHLIST = [
  "300017", "300454", "301202", "301251", "688432", "002129", "688126", "605358",
  "300043", "002558", "600288", "600004", "000089", "600897", "600221"
];

async function fetchSinaMarketCount() {
  const url = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount?node=hs_a";
  const text = await fetchText(url, { referer: "https://vip.stock.finance.sina.com.cn/", timeout: 22000 });
  return Number(String(text).replace(/"/g, ""));
}

async function fetchSinaMarketPage(page, pageSize = 100, node = "hs_a") {
  const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=${pageSize}&sort=symbol&asc=1&node=${node}&symbol=&_s_r_a=init`;
  const text = await fetchText(url, { referer: "https://vip.stock.finance.sina.com.cn/", timeout: 30000 });
  return Function(`return ${text}`)();
}

async function fetchSinaIndustryNodes() {
  const url = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodes";
  const text = await fetchText(url, { referer: "https://vip.stock.finance.sina.com.cn/", timeout: 22000 });
  const root = Function(`return ${text}`)();
  const nodes = [];
  function walk(item, inIndustry = false) {
    if (!Array.isArray(item)) return;
    const name = item[0];
    const children = item[1];
    const node = item[2];
    const nowIndustry = inIndustry || name === "新浪行业";
    if (nowIndustry && typeof node === "string" && node.startsWith("new_")) nodes.push({ name, node });
    if (Array.isArray(children)) for (const child of children) walk(child, nowIndustry);
  }
  walk(root);
  return nodes;
}

async function fetchSinaIndustrySectors() {
  const nodes = await fetchSinaIndustryNodes();
  const result = [];
  const chunkSize = 8;
  for (let i = 0; i < nodes.length; i += chunkSize) {
    const chunk = nodes.slice(i, i + chunkSize);
    const batch = await Promise.all(chunk.map(async n => {
      try {
        const data = await fetchSinaMarketPage(1, 300, n.node);
        const valid = data.filter(r => Number.isFinite(Number(r.changepercent)));
        if (!valid.length) return null;
        const avgPct = valid.reduce((sum, r) => sum + Number(r.changepercent), 0) / valid.length;
        const amount = valid.reduce((sum, r) => sum + Number(r.amount || 0), 0);
        return {
          code: n.node,
          name: n.name,
          price: null,
          pct: round(avgPct),
          amountYi: yi(amount),
          turnover: null,
          marketCapYi: null,
          up: valid.filter(r => Number(r.changepercent) > 0).length,
          down: valid.filter(r => Number(r.changepercent) < 0).length,
          source: "新浪行业成分股聚合"
        };
      } catch {
        return null;
      }
    }));
    result.push(...batch.filter(Boolean));
  }
  return {
    top: [...result].sort((a, b) => b.pct - a.pct).slice(0, 30),
    bottom: [...result].sort((a, b) => a.pct - b.pct).slice(0, 30)
  };
}

async function fetchSinaAllAStocks() {
  const pageSize = 100;
  const total = await fetchSinaMarketCount();
  const pages = Math.ceil(total / pageSize);
  const rows = [];
  for (let page = 1; page <= pages; page += 1) {
    rows.push(...await fetchSinaMarketPage(page, pageSize));
  }
  return rows.map(r => ({
    code: r.code,
    name: r.name,
    price: round(r.trade),
    pct: round(r.changepercent),
    change: round(r.pricechange),
    volumeHands: round(Number(r.volume) / 100, 0),
    amountYi: yi(r.amount),
    amplitude: null,
    turnover: round(r.turnoverratio),
    pe: round(r.per),
    volumeRatio: null,
    high: round(r.high),
    low: round(r.low),
    open: round(r.open),
    prevClose: round(r.settlement),
    marketCapYi: yi(Number(r.mktcap) * 10000),
    floatCapYi: yi(Number(r.nmc) * 10000),
    pb: round(r.pb),
    mainNetInflowYi: null,
    symbol: r.symbol,
    ticktime: r.ticktime,
    dataScope: "sina-full-market"
  }));
}

function sinaSymbol(code) {
  if (code.startsWith("8") || code.startsWith("9")) return `bj${code}`;
  return `${code.startsWith("6") ? "sh" : "sz"}${code}`;
}

function normalizeSinaStock(row) {
  const v = row.values;
  const code = row.symbol.slice(2);
  const open = Number(v[1]);
  const prevClose = Number(v[2]);
  const price = Number(v[3]);
  const high = Number(v[4]);
  const low = Number(v[5]);
  const volume = Number(v[8]);
  const amount = Number(v[9]);
  return {
    code,
    name: v[0],
    price: round(price),
    pct: prevClose ? round((price - prevClose) / prevClose * 100) : null,
    change: prevClose ? round(price - prevClose) : null,
    volumeHands: round(volume / 100, 0),
    amountYi: yi(amount),
    amplitude: prevClose ? round((high - low) / prevClose * 100) : null,
    turnover: null,
    pe: null,
    volumeRatio: null,
    high: round(high),
    low: round(low),
    open: round(open),
    prevClose: round(prevClose),
    marketCapYi: null,
    floatCapYi: null,
    pb: null,
    mainNetInflowYi: null,
    dataScope: "fallback-watchlist"
  };
}

async function fetchFallbackStocks() {
  const rows = await fetchSinaQuotes(FALLBACK_WATCHLIST.map(sinaSymbol));
  return rows
    .filter(r => r.values?.[0] && Number(r.values?.[3]) > 0)
    .map(normalizeSinaStock);
}

function normalizeIndex(row) {
  const v = row.values;
  const current = Number(v[3]);
  const prev = Number(v[2]);
  return {
    symbol: row.symbol,
    name: v[0],
    current: round(current, 2),
    prevClose: round(prev, 2),
    open: round(v[1], 2),
    high: round(v[4], 2),
    low: round(v[5], 2),
    pct: prev ? round((current - prev) / prev * 100) : null,
    amountYi: yi(v[9]),
    time: `${v[30] || ""} ${v[31] || ""}`.trim()
  };
}

function normalizeGlobal(row) {
  const v = row.values;
  if (row.symbol.startsWith("gb_")) {
    return {
      symbol: row.symbol,
      name: v[0],
      current: round(v[1], 2),
      pct: round(v[2]),
      change: round(v[4]),
      sourceTime: v[3] || v[25] || ""
    };
  }
  if (row.symbol === "USDCNY") {
    return {
      symbol: row.symbol,
      name: "美元/人民币",
      current: round(v[1], 4),
      pct: null,
      high: round(v[5], 4),
      low: round(v[6], 4),
      sourceTime: `${v[10] || ""} ${v[0] || ""}`.trim()
    };
  }
  return {
    symbol: row.symbol,
    name: v[13] || row.symbol,
    current: round(v[0], 2),
    pct: null,
    high: round(v[4], 2),
    low: round(v[5], 2),
    sourceTime: `${v[12] || ""} ${v[6] || ""}`.trim()
  };
}

function buildBreadth(stocks) {
  const valid = stocks.filter(s => Number.isFinite(s.pct));
  return {
    total: valid.length,
    up: valid.filter(s => s.pct > 0).length,
    flat: valid.filter(s => s.pct === 0).length,
    down: valid.filter(s => s.pct < 0).length,
    limitUp: valid.filter(s => s.pct >= 9.8).length,
    limitDown: valid.filter(s => s.pct <= -9.8).length
  };
}

function marketPhase(indices, breadth, turnoverYi) {
  const sh = indices.find(x => x.symbol === "sh000001");
  const cyb = indices.find(x => x.symbol === "sz399006");
  const downRatio = breadth.total ? breadth.down / breadth.total : 0;
  if ((sh?.pct ?? 0) < -1 && downRatio > 0.65) return "弱势防守";
  if ((sh?.pct ?? 0) > 0.8 && (cyb?.pct ?? 0) > 0.8 && breadth.up > breadth.down) return "进攻修复";
  if (turnoverYi && turnoverYi > 18000 && breadth.up > breadth.down) return "结构活跃";
  return "震荡观察";
}

function scoreCandidate(stock) {
  let score = 0;
  const reasons = [];
  if (stock.pct >= 9.8) { score += 24; reasons.push("接近或达到涨停，短线资金关注度高"); }
  else if (stock.pct >= 5) { score += 16; reasons.push("涨幅超过5%，有主动资金推动"); }
  else if (stock.pct >= 3) { score += 9; reasons.push("涨幅超过3%，强于多数个股"); }
  if ((stock.amountYi || 0) >= 10) { score += 18; reasons.push(`成交额${stock.amountYi}亿元，流动性可跟踪`); }
  else if ((stock.amountYi || 0) >= 3) { score += 10; reasons.push(`成交额${stock.amountYi}亿元，具备观察流动性`); }
  if ((stock.turnover || 0) >= 5) { score += 8; reasons.push(`换手率${stock.turnover}%，资金分歧充分`); }
  if ((stock.volumeRatio || 0) >= 2) { score += 8; reasons.push(`量比${stock.volumeRatio}，明显放量`); }
  if (stock.pe && stock.pe > 0 && stock.pe < 60) { score += 8; reasons.push(`动态PE ${stock.pe}，估值未进入极端高位`); }
  if (stock.pb && stock.pb > 0 && stock.pb < 8) { score += 5; reasons.push(`PB ${stock.pb}，需与同行继续比较`); }
  if ((stock.mainNetInflowYi || 0) > 0) { score += 6; reasons.push(`主力净流入${stock.mainNetInflowYi}亿元`); }
  if (/ST|退/.test(stock.name)) score -= 50;
  const grade = score >= 58 ? "A-" : score >= 46 ? "B+" : score >= 34 ? "B" : "C+";
  return { score, grade, reasons };
}

const TRADING_PREFERENCES = {
  focusAreas: ["科技", "锂电", "储能"],
  includeKeywords: [
    "半导体", "芯片", "集成电路", "电子", "软件", "IT", "计算机", "通信", "云计算", "人工智能",
    "AI", "机器人", "数据中心", "服务器", "光模块", "网络安全", "消费电子", "电子元件",
    "锂", "锂电", "电池", "储能", "新能源", "光伏", "固态电池", "钠电池", "电网设备", "氢能源",
    "有机硅", "硅材料", "新材料"
  ],
  excludeKeywords: [
    "银行", "保险", "证券", "多元金融", "白酒", "饮料", "食品", "商贸零售", "旅游", "酒店",
    "房地产", "煤炭", "水泥", "钢铁"
  ]
};

function preferenceText(stock) {
  return [stock.name, stock.symbol, stock.industryName, stock.industryPath, ...(stock.concepts || [])].filter(Boolean).join(" ");
}

function classifyPreferenceFromText(text) {
  const excluded = TRADING_PREFERENCES.excludeKeywords.find(k => text.includes(k));
  if (excluded) return { matched: false, area: "排除", reason: `命中暂不关注方向：${excluded}` };
  const hits = TRADING_PREFERENCES.includeKeywords.filter(k => text.includes(k));
  if (!hits.length) return { matched: false, area: "非重点", reason: "未命中科技、锂电、储能关键词" };
  let area = "科技";
  if (hits.some(k => ["锂", "锂电", "电池", "储能", "新能源", "固态电池", "钠电池", "电网设备", "氢能源"].includes(k))) area = "能源/锂电/储能";
  return { matched: true, area, reason: `命中偏好关键词：${hits.slice(0, 5).join("、")}`, hits };
}

function baseCandidateRisks(stock) {
  const risk = [];
  if (stock.pct >= 9.8) risk.push("短线涨幅已大，不能把涨停等同于买点");
  if (!stock.pe || stock.pe < 0) risk.push("动态PE缺失或为负，盈利质量需要重点核查");
  if ((stock.turnover || 0) > 15) risk.push("换手过高，次日波动风险较大");
  return risk.length ? risk : ["需要公告、财报、技术位继续验证"];
}

function buildCandidates(stocks) {
  const filtered = stocks
    .filter(s => !/ST|退/.test(s.name))
    .filter(s => (s.amountYi || 0) >= 0.2 && (s.pct || 0) >= -20)
    .map(s => ({ ...s, preference: classifyPreferenceFromText(preferenceText(s)) }))
    .filter(s => s.preference.matched)
    .map(s => ({
      ...s,
      analysis: {
        ...scoreCandidate(s),
        next: [
          `偏好匹配：${s.preference.reason}`,
          "核对所属行业是否与今日强势方向一致",
          "核对最近一期财报的收入、利润、现金流是否支撑涨幅",
          "观察放量后是否回踩不破启动区间，避免高开低走兑现"
        ],
        risk: baseCandidateRisks(s)
      }
    }))
    .sort((a, b) => b.analysis.score - a.analysis.score)
    .slice(0, 18);
  return filtered;
}

function secid(code) {
  return `${code.startsWith("6") ? "1" : "0"}.${code}`;
}

async function fetchReport(code, reportName, pageSize = 4) {
  const params = new URLSearchParams({
    reportName,
    columns: "ALL",
    filter: `(SECURITY_CODE="${code}")`,
    pageNumber: "1",
    pageSize: String(pageSize),
    sortColumns: "REPORT_DATE",
    sortTypes: "-1"
  });
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?${params.toString()}`;
  const json = await fetchJson(url, { referer: "https://data.eastmoney.com/", timeout: 22000 });
  return json?.result?.data || [];
}

async function fetchAnnouncements(code) {
  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=5&page_index=1&ann_type=A&client_source=web&stock_list=${code}`;
  const json = await fetchJson(url, { referer: "https://data.eastmoney.com/", timeout: 22000 });
  const anns = (json?.data?.list || []).map(a => ({
    title: a.title_ch || a.title,
    date: (a.notice_date || "").slice(0, 10),
    displayTime: a.display_time || "",
    type: (a.columns || []).map(c => c.column_name).join("、") || "公告",
    code: a.art_code
  }));
  const enriched = [];
  for (const ann of anns) {
    enriched.push(await enrichAnnouncementLink(ann));
  }
  return enriched;
}

async function enrichAnnouncementLink(ann) {
  try {
    const url = `https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=${ann.code}&client_source=web&page_index=1`;
    const json = await fetchJson(url, { referer: "https://data.eastmoney.com/", timeout: 16000 });
    return {
      ...ann,
      pdfUrl: json?.data?.attach_url || json?.data?.attach_list?.[0]?.attach_url || "",
      pageCount: json?.data?.page_size || json?.data?.page_count || null
    };
  } catch {
    return ann;
  }
}

async function fetchCompanyProfile(code) {
  const params = new URLSearchParams({
    reportName: "RPT_F10_ORG_BASICINFO",
    columns: "ALL",
    filter: `(SECURITY_CODE="${code}")`,
    pageNumber: "1",
    pageSize: "1"
  });
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?${params.toString()}`;
  const json = await fetchJson(url, { referer: "https://data.eastmoney.com/", timeout: 22000 });
  const r = json?.result?.data?.[0] || {};
  return {
    orgName: r.ORG_NAME || "",
    region: r.REGIONBK || "",
    industryPath: r.EM2016 || "",
    concepts: String(r.BLGAINIAN || "").split(",").filter(Boolean).slice(0, 12),
    chairman: r.CHAIRMAN || "",
    president: r.PRESIDENT || "",
    secretary: r.SECRETARY || "",
    founded: (r.FOUND_DATE || "").slice(0, 10),
    employees: r.TOTAL_NUM || null,
    website: r.ORG_WEB || "",
    profile: String(r.ORG_PROFIE || "").replace(/\s+/g, " ").trim().slice(0, 260),
    source: "东方财富F10基础资料"
  };
}

async function fetchKline(code) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid(code)}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=20250101&end=20500101`;
  const json = await fetchJson(url, { referer: "https://quote.eastmoney.com/", timeout: 22000 });
  return (json?.data?.klines || []).map(line => {
    const [date, open, close, high, low, volume, amount, amplitude, pctChange, change, turnover] = line.split(",");
    return {
      date,
      open: round(open),
      close: round(close),
      high: round(high),
      low: round(low),
      volume: Number(volume),
      amountYi: yi(amount),
      amplitude: round(amplitude),
      pct: round(pctChange),
      change: round(change),
      turnover: round(turnover)
    };
  });
}

async function fetchSinaKline(code) {
  const symbol = sinaSymbol(code);
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=160`;
  const rows = await fetchJson(url, { referer: "https://finance.sina.com.cn/", timeout: 22000 });
  return (Array.isArray(rows) ? rows : []).map(r => ({
    date: r.day,
    open: round(r.open),
    close: round(r.close),
    high: round(r.high),
    low: round(r.low),
    volume: Number(r.volume),
    amountYi: null,
    amplitude: null,
    pct: null,
    change: null,
    turnover: null
  }));
}

async function fetchSinaMinuteKline(code, scale = 30) {
  const symbol = sinaSymbol(code);
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symbol}&scale=${scale}&ma=no&datalen=160`;
  const rows = await fetchJson(url, { referer: "https://finance.sina.com.cn/", timeout: 22000 });
  return (Array.isArray(rows) ? rows : []).map(r => ({
    date: r.day,
    open: round(r.open),
    close: round(r.close),
    high: round(r.high),
    low: round(r.low),
    volume: Number(r.volume)
  }));
}

function avg(rows, field) {
  const vals = rows.map(r => Number(r[field])).filter(Number.isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function analyzeTechnical(klines, minuteKlines = []) {
  if (!klines.length) return { status: "缺K线", conclusion: "无法判断技术结构", supports: [], risks: [] };
  const last = klines[klines.length - 1];
  const last20 = klines.slice(-20);
  const last60 = klines.slice(-60);
  const ma5 = avg(klines.slice(-5), "close");
  const ma20 = avg(last20, "close");
  const ma60 = avg(last60, "close");
  const high20 = Math.max(...last20.map(k => k.high));
  const low20 = Math.min(...last20.map(k => k.low));
  const mid20 = (high20 + low20) / 2;
  const supports = [];
  const risks = [];
  if (last.close >= high20 * 0.98) supports.push("收盘接近20日高位，短线趋势较强");
  if (ma5 && ma20 && ma5 > ma20) supports.push("5日均线高于20日均线");
  if (ma20 && ma60 && ma20 > ma60) supports.push("20日均线高于60日均线，中期结构偏强");
  if (last.close < ma20) risks.push("收盘低于20日均线，技术结构需降级");
  if (last.turnover && last.turnover > 15) risks.push("换手偏高，次日波动可能放大");
  const status = supports.length >= 2 ? "趋势偏强" : risks.length ? "技术待确认" : "震荡观察";
  const minute = analyzeMinuteStructure(minuteKlines);
  const chan = buildChanDecision({ last, ma5, ma20, ma60, high20, low20, mid20, status, minute });
  return {
    status,
    lastDate: last.date,
    close: last.close,
    ma5: round(ma5),
    ma20: round(ma20),
    ma60: round(ma60),
    high20: round(high20),
    low20: round(low20),
    mid20: round(mid20),
    supports,
    risks,
    conclusion: status === "趋势偏强" ? "可观察回踩确认，不追高" : "等待结构更清晰",
    minute,
    chan
  };
}

function analyzeMinuteStructure(rows) {
  if (!rows.length) return { status: "缺30分钟线", conclusion: "无法做多级别确认", supports: [], risks: [] };
  const last = rows[rows.length - 1];
  const recent = rows.slice(-48);
  const high = Math.max(...recent.map(r => r.high));
  const low = Math.min(...recent.map(r => r.low));
  const mid = (high + low) / 2;
  const ma12 = avg(recent.slice(-12), "close");
  const ma48 = avg(recent, "close");
  const supports = [];
  const risks = [];
  if (last.close > ma12 && ma12 > ma48) supports.push("30分钟级别短均线向上");
  if (last.close > mid) supports.push("30分钟价格位于近48根中枢中位上方");
  if (last.close < ma48) risks.push("30分钟收盘低于近48根均价");
  if (last.close < mid) risks.push("30分钟仍在中位下方，买点确认不足");
  return {
    status: supports.length >= 2 ? "30分钟确认偏强" : risks.length ? "30分钟待确认" : "30分钟震荡",
    lastDate: last.date,
    high: round(high),
    low: round(low),
    mid: round(mid),
    ma12: round(ma12),
    ma48: round(ma48),
    supports,
    risks,
    conclusion: supports.length >= 2 ? "日K买点可获得低级别确认" : "需要等待30分钟级别重新转强"
  };
}

function buildChanDecision({ last, ma5, ma20, ma60, high20, low20, mid20, status, minute }) {
  const price = last.close;
  const range = high20 - low20;
  const nearHigh = high20 ? price >= high20 * 0.98 : false;
  const nearLow = low20 ? price <= low20 * 1.05 : false;
  const aboveCenter = price >= mid20;
  const belowMa20 = ma20 && price < ma20;
  const stop = low20 ? round(Math.min(low20, ma20 || low20) * 0.97) : null;
  const add = ma5 && ma20 ? round(Math.max(ma5, ma20)) : round(mid20);
  const takeProfit = high20 ? round(high20 * 1.08) : null;
  let point = "无明确买点";
  let action = "观察";
  const conditions = [];
  const invalidation = [];
  const minuteConfirm = minute?.status === "30分钟确认偏强";

  if (status === "趋势偏强" && nearHigh) {
    point = "类三买观察区";
    action = "不追高，等待突破后回踩不跌回20日高位区再考虑试仓";
    conditions.push(`放量突破或站稳20日高点${round(high20)}后，回踩不跌破${round(add)}`);
    conditions.push(minuteConfirm ? "30分钟已偏强，仍需回踩不破确认" : "等待30分钟重新转强后，才视为类三买确认");
    invalidation.push(`跌回20日中枢中位${round(mid20)}下方，三买观察失效`);
  } else if (status === "趋势偏强" && aboveCenter) {
    point = "类二买/趋势延续观察";
    action = "等待回踩MA20或中枢上沿附近企稳，低仓位试错";
    conditions.push(`回踩不破MA20 ${round(ma20)} 或20日中位${round(mid20)}`);
    conditions.push(minuteConfirm ? "30分钟结构偏强，可跟踪缩量回踩" : "30分钟未确认前不加仓");
    invalidation.push(`跌破20日低点${round(low20)}或MA20后无法收回，观察取消`);
  } else if (nearLow && !belowMa20) {
    point = "潜在一买观察";
    action = "只做观察，等待底分型和放量确认";
    conditions.push(`接近20日低点${round(low20)}后不再创新低`);
    conditions.push("出现明显反包或连续两日收回MA5后再评估");
    invalidation.push(`有效跌破20日低点${round(low20)}，一买观察失败`);
  } else if (belowMa20) {
    point = "无买点/风险段";
    action = "不建仓，已有持仓以MA20和20日低点作为减仓观察";
    conditions.push(`重新站回MA20 ${round(ma20)}，并形成更高低点后再看`);
    invalidation.push(`跌破20日低点${round(low20)}，技术面减分`);
  } else {
    point = "中枢震荡观察";
    action = "等待向上离开中枢或向下回踩低吸条件，不在中位反复区重仓";
    conditions.push(`20日区间约${round(low20)}-${round(high20)}，中位${round(mid20)}`);
    invalidation.push(`跌破${round(low20)}说明震荡中枢下破`);
  }

  return {
    point,
    action,
    positionHint: point.includes("三买") ? "试仓或持仓观察，不适合追高满仓" : point.includes("二买") ? "轻仓试错，确认后再加仓" : "等待",
    entryZone: point.includes("无买点") ? "暂无" : `${round(Math.max(low20, mid20 - range * 0.15))}-${round(Math.min(high20, mid20 + range * 0.25))}`,
    stop,
    add,
    takeProfit,
    conditions,
    invalidation,
    minuteConfirm,
    caveat: "当前已接入日K和30分钟K线做近似缠论判断，但笔、线段、中枢和背驰仍需算法完善与人工复核。"
  };
}

function latest(rows) {
  return rows && rows.length ? rows[0] : null;
}

function analyzeFinancial(incomeRows, balanceRows, cashRows) {
  const income = latest(incomeRows);
  const balance = latest(balanceRows);
  const cash = latest(cashRows);
  if (!income && !balance && !cash) {
    return { status: "财报缺失", supports: [], risks: ["未取得三表数据"], conclusion: "基本面不能加分" };
  }
  const supports = [];
  const risks = [];
  const grossMargin = income?.TOTAL_OPERATE_INCOME && income?.OPERATE_COST !== null
    ? (income.TOTAL_OPERATE_INCOME - income.OPERATE_COST) / income.TOTAL_OPERATE_INCOME * 100
    : null;
  const roeApprox = balance?.TOTAL_EQUITY ? income?.PARENT_NETPROFIT / balance.TOTAL_EQUITY * 100 : null;
  if (income?.PARENT_NETPROFIT_RATIO > 0) supports.push(`归母净利润同比增长${round(income.PARENT_NETPROFIT_RATIO)}%`);
  if (income?.PARENT_NETPROFIT_RATIO < 0) risks.push(`归母净利润同比下降${round(Math.abs(income.PARENT_NETPROFIT_RATIO))}%`);
  if (income?.TOI_RATIO > 0) supports.push(`营业收入同比增长${round(income.TOI_RATIO)}%`);
  if (income?.TOI_RATIO < 0) risks.push(`营业收入同比下降${round(Math.abs(income.TOI_RATIO))}%`);
  if (cash?.NETCASH_OPERATE > 0) supports.push(`经营现金流为正：${yi(cash.NETCASH_OPERATE)}亿元`);
  if (cash?.NETCASH_OPERATE < 0) risks.push(`经营现金流为负：${yi(cash.NETCASH_OPERATE)}亿元`);
  if (balance?.DEBT_ASSET_RATIO !== null && balance?.DEBT_ASSET_RATIO < 50) supports.push(`资产负债率${round(balance.DEBT_ASSET_RATIO)}%，财务压力可控`);
  if (balance?.DEBT_ASSET_RATIO > 70) risks.push(`资产负债率${round(balance.DEBT_ASSET_RATIO)}%，财务压力偏高`);
  if (balance?.ACCOUNTS_RECE_RATIO > 30) risks.push(`应收账款同比增长${round(balance.ACCOUNTS_RECE_RATIO)}%，需关注回款质量`);
  if (balance?.INVENTORY_RATIO > 30) risks.push(`存货同比增长${round(balance.INVENTORY_RATIO)}%，需关注跌价风险`);
  if (grossMargin !== null && grossMargin > 30) supports.push(`毛利率约${round(grossMargin)}%，盈利结构较好`);
  if (grossMargin !== null && grossMargin < 10) risks.push(`毛利率约${round(grossMargin)}%，盈利弹性偏弱`);
  if (roeApprox !== null && roeApprox > 3) supports.push(`单季ROE约${round(roeApprox)}%，需年化观察`);
  if (roeApprox !== null && roeApprox < 0) risks.push(`单季ROE为负，盈利质量减分`);
  const status = risks.length === 0 && supports.length >= 3 ? "基本面支撑较好" : risks.length > supports.length ? "基本面减分" : "基本面待验证";
  return {
    status,
    reportDate: (income?.REPORT_DATE || balance?.REPORT_DATE || cash?.REPORT_DATE || "").slice(0, 10),
    noticeDate: (income?.NOTICE_DATE || balance?.NOTICE_DATE || cash?.NOTICE_DATE || "").slice(0, 10),
    industry: income?.INDUSTRY_NAME || balance?.INDUSTRY_NAME || "",
    revenueYi: yi(income?.TOTAL_OPERATE_INCOME),
    revenueYoY: pct(income?.TOI_RATIO),
    netProfitYi: yi(income?.PARENT_NETPROFIT),
    netProfitYoY: pct(income?.PARENT_NETPROFIT_RATIO),
    deductNetProfitYi: yi(income?.DEDUCT_PARENT_NETPROFIT),
    deductNetProfitYoY: pct(income?.DPN_RATIO),
    debtAssetRatio: pct(balance?.DEBT_ASSET_RATIO),
    accountsReceivableYi: yi(balance?.ACCOUNTS_RECE),
    accountsReceivableYoY: pct(balance?.ACCOUNTS_RECE_RATIO),
    inventoryYi: yi(balance?.INVENTORY),
    inventoryYoY: pct(balance?.INVENTORY_RATIO),
    operatingCashflowYi: yi(cash?.NETCASH_OPERATE),
    operatingCashflowYoY: pct(cash?.NETCASH_OPERATE_RATIO),
    grossMargin: pct(grossMargin),
    roeApprox: pct(roeApprox),
    supports,
    risks,
    conclusion: status === "基本面支撑较好" ? "财报可为行情加分，但仍需公告和估值确认" : "不能仅凭行情强势升级为买入"
  };
}

function analyzeAnnouncements(anns) {
  const riskWords = ["减持", "问询", "诉讼", "处罚", "冻结", "亏损", "终止", "退市", "立案"];
  const positiveWords = ["中标", "回购", "增持", "业绩预增", "重大合同", "投资者关系"];
  const risks = anns.filter(a => riskWords.some(w => a.title.includes(w)));
  const positives = anns.filter(a => positiveWords.some(w => a.title.includes(w)));
  return {
    latest: anns.slice(0, 5),
    risks: risks.map(a => `${a.date} ${a.title}`),
    positives: positives.map(a => `${a.date} ${a.title}`),
    status: risks.length ? "公告风险待核查" : positives.length ? "公告偏正面" : anns.length ? "常规公告" : "公告缺失",
    conclusion: risks.length ? "相关股票需要降级或暂停升级" : "未发现标题级重大负面，仍需公告正文确认"
  };
}

function buildTradePlan(stock, financial, announcements, technical, preference) {
  const chan = technical.chan || {};
  const riskFlags = [
    ...(financial.risks || []),
    ...(announcements.risks || []),
    ...(technical.risks || []),
    ...(chan.invalidation || [])
  ];
  const logicOk = financial.status === "基本面支撑较好" || financial.status === "基本面待验证";
  const riskBlocked = financial.status === "基本面减分" || announcements.status === "公告风险待核查";
  const nearBuy = ["类二买/趋势延续观察", "类三买观察区"].includes(chan.point);
  const minuteOk = technical.minute?.status === "30分钟确认偏强";
  let state = "观察池";
  if (riskBlocked) state = "风险观察";
  else if (nearBuy && minuteOk && logicOk) state = "交易准备池";
  else if (nearBuy && logicOk) state = "重点跟踪池";
  else if (chan.point === "无买点/风险段") state = "暂不交易";

  let firstPosition = "0";
  let buildRhythm = "等待买点确认";
  if (state === "交易准备池") {
    firstPosition = "试仓10%-20%";
    buildRhythm = "先试仓；回踩不破关键位且30分钟再次转强后加到30%-40%；弱市不满仓";
  } else if (state === "重点跟踪池") {
    firstPosition = "0%-10%观察仓";
    buildRhythm = "只允许小仓试错，等待30分钟确认后再提高仓位";
  } else if (state === "风险观察" || state === "暂不交易") {
    firstPosition = "0";
    buildRhythm = "不建仓，等待风险解除或结构修复";
  }

  return {
    state,
    focusArea: preference.area,
    preferenceReason: preference.reason,
    buyType: chan.point || "缺失",
    entryZone: chan.entryZone || "暂无",
    firstPosition,
    buildRhythm,
    addCondition: (chan.conditions || []).join("；") || "暂无",
    reduceCondition: (chan.invalidation || []).join("；") || "暂无",
    stop: chan.stop,
    takeProfit: chan.takeProfit,
    expectedHolding: state === "交易准备池" ? "短中线跟踪，先看3-10个交易日买点兑现" : "等待触发，不预设持仓",
    todayAction: state === "交易准备池" ? "不追高，等待回踩或低级别确认后的计划内试仓" : state === "重点跟踪池" ? "重点盯盘，不主动追买" : "不交易",
    tomorrowWatch: ["是否跌破失效位", "30分钟是否继续保持强势", "公告是否出现风险", "成交额和换手是否异常放大"],
    riskFlags: riskFlags.slice(0, 6)
  };
}

async function enrichCandidate(stock) {
  const [incomeRows, balanceRows, cashRows, annRows, klines, minuteKlines, companyProfile] = await Promise.all([
    guarded(`利润表 ${stock.code}`, () => fetchReport(stock.code, "RPT_DMSK_FN_INCOME"), []),
    guarded(`资产负债表 ${stock.code}`, () => fetchReport(stock.code, "RPT_DMSK_FN_BALANCE"), []),
    guarded(`现金流量表 ${stock.code}`, () => fetchReport(stock.code, "RPT_DMSK_FN_CASHFLOW"), []),
    guarded(`公告 ${stock.code}`, () => fetchAnnouncements(stock.code), []),
    guarded(`日K ${stock.code}`, async () => {
      const eastmoney = await guarded(`东方财富日K ${stock.code}`, () => fetchKline(stock.code), []);
      if (eastmoney.length) return eastmoney;
      return guarded(`新浪日K ${stock.code}`, () => fetchSinaKline(stock.code), []);
    }, []),
    guarded(`30分钟K ${stock.code}`, () => fetchSinaMinuteKline(stock.code, 30), []),
    guarded(`公司F10 ${stock.code}`, () => fetchCompanyProfile(stock.code), {})
  ]);
  const financial = analyzeFinancial(incomeRows, balanceRows, cashRows);
  const announcements = analyzeAnnouncements(annRows);
  const technical = analyzeTechnical(klines, minuteKlines);
  const cleanName = latest(incomeRows)?.SECURITY_NAME_ABBR || latest(balanceRows)?.SECURITY_NAME_ABBR || stock.name;
  const enrichedPreference = classifyPreferenceFromText([
    cleanName,
    companyProfile.industryPath,
    companyProfile.profile,
    ...(companyProfile.concepts || []),
    financial.industry
  ].filter(Boolean).join(" "));
  const finalPreference = enrichedPreference.matched ? enrichedPreference : stock.preference;
  const tradePlan = buildTradePlan(stock, financial, announcements, technical, finalPreference);
  const scoreAdjust = (financial.supports.length * 3) - (financial.risks.length * 4) + (technical.supports.length * 2) - (technical.risks.length * 2) - (announcements.risks.length * 8);
  const totalScore = Math.max(0, Math.min(100, stock.analysis.score + scoreAdjust));
  const grade = totalScore >= 70 ? "A" : totalScore >= 58 ? "A-" : totalScore >= 46 ? "B+" : totalScore >= 34 ? "B" : "C+";
  return {
    ...stock,
    name: cleanName,
    preference: finalPreference,
    financial,
    companyProfile,
    announcements,
    technical,
    tradePlan,
    analysis: {
      ...stock.analysis,
      rawScore: stock.analysis.score,
      score: totalScore,
      grade,
      scoreAdjust,
      reasons: [
        ...stock.analysis.reasons,
        ...financial.supports.slice(0, 2),
        ...technical.supports.slice(0, 2),
        ...announcements.positives.slice(0, 1)
      ],
      next: [
        ...(stock.analysis.next || []),
        `缠论观察：${technical.chan?.point || "缺K线"}；${technical.chan?.action || "等待K线补齐"}`,
        `操作条件：${(technical.chan?.conditions || []).slice(0, 2).join("；") || "暂无"}`
      ],
      risk: [
        ...stock.analysis.risk,
        ...financial.risks,
        ...technical.risks,
        ...(technical.chan?.invalidation || []),
        ...announcements.risks
      ]
    }
  };
}

async function enrichCandidates(candidates) {
  const enriched = [];
  const concurrency = 4;
  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    enriched.push(...await Promise.all(batch.map(enrichCandidate)));
  }
  const stateRank = { "交易准备池": 5, "重点跟踪池": 4, "观察池": 3, "风险观察": 2, "暂不交易": 1 };
  return enriched.sort((a, b) => (stateRank[b.tradePlan?.state] || 0) - (stateRank[a.tradePlan?.state] || 0) || b.analysis.score - a.analysis.score);
}

function buildEvents(indices, sectors, globalAssets, breadth, candidates) {
  const events = [];
  const strong = sectors.top[0];
  const weak = sectors.bottom[0];
  if (strong) events.push({
    name: `${strong.name}板块领涨`,
    source: "东方财富行业板块行情",
    type: "行业主线",
    signal: `${strong.pct}%`,
    impact: "推送至第3章、第8章、第9章",
    conclusion: "只代表当日资金方向，需要持续性和公司基本面确认"
  });
  if (weak) events.push({
    name: `${weak.name}板块领跌`,
    source: "东方财富行业板块行情",
    type: "风险扩散",
    signal: `${weak.pct}%`,
    impact: "推送至第8章、第13章",
    conclusion: "弱势方向相关股票降低进攻评级"
  });
  const risky = candidates.filter(c => c.announcements?.risks?.length).slice(0, 5);
  for (const c of risky) events.push({
    name: `${c.name}公告风险`,
    source: "东方财富公告",
    type: "个股公告",
    signal: c.announcements.risks[0],
    impact: "推送至第4章、第5章、第9章、第13章",
    conclusion: "候选池降级，等待公告正文复核"
  });
  const us = globalAssets.filter(x => ["gb_dji", "gb_ixic", "gb_inx"].includes(x.symbol));
  if (us.length) events.push({
    name: "美股主要指数映射",
    source: "新浪财经全球行情",
    type: "海外映射",
    signal: us.map(x => `${x.name}${x.pct}%`).join(" / "),
    impact: "影响A股科技成长、风险偏好和全球资金定价",
    conclusion: "海外映射不能直接转为A股买点，必须结合A股成交额和行业强度"
  });
  if (breadth.down > breadth.up) events.push({
    name: "市场宽度偏弱",
    source: "东方财富全A行情统计",
    type: "市场阶段",
    signal: `上涨${breadth.up} / 下跌${breadth.down}`,
    impact: "降低技术买点、候选池和仓位建议等级",
    conclusion: "局部强势股按观察处理，避免弱市追高"
  });
  return events;
}

function buildMacroSummary(globalAssets, indices, breadth) {
  const item = symbol => globalAssets.find(x => x.symbol === symbol);
  const usdcny = item("USDCNY");
  const nasdaq = item("gb_ixic");
  const spx = item("gb_inx");
  const gold = item("hf_GC");
  const oil = item("hf_CL");
  const risk = [];
  const support = [];
  if (nasdaq?.pct > 0 || spx?.pct > 0) support.push("美股科技/标普偏强，对A股科技成长风险偏好有支撑");
  if (nasdaq?.pct < -1 || spx?.pct < -1) risk.push("美股科技或标普明显回落，A股成长方向需降级观察");
  if (usdcny?.current && usdcny.current > 7.1) risk.push(`美元/人民币${usdcny.current}，汇率压力偏高`);
  if (usdcny?.current && usdcny.current <= 7.0) support.push(`美元/人民币${usdcny.current}，汇率压力相对可控`);
  if (gold?.current) support.push(`黄金${gold.current}，避险和贵金属方向需纳入观察`);
  if (oil?.current) risk.push(`原油${oil.current}，会影响通胀和部分化工成本`);
  if (breadth.down > breadth.up) risk.push(`A股下跌家数${breadth.down}多于上涨${breadth.up}，外部利好需要A股内部确认`);
  const conclusion = risk.length > support.length ? "宏观与市场映射偏谨慎" : support.length > risk.length ? "宏观映射中性偏积极" : "宏观映射中性";
  return {
    conclusion,
    support,
    risk,
    mapping: [
      ["美股科技", `${nasdaq?.name || "纳指"} ${nasdaq?.pct ?? "缺失"}%`, "映射A股AI、半导体、软件，但必须由A股成交额和行业强度确认"],
      ["汇率", `美元/人民币 ${usdcny?.current ?? "缺失"}`, "汇率稳定利于外资和成长估值，快速贬值时降低仓位"],
      ["黄金", `${gold?.name || "黄金"} ${gold?.current ?? "缺失"}`, "上行偏避险，映射贵金属和防御情绪"],
      ["原油", `${oil?.name || "原油"} ${oil?.current ?? "缺失"}`, "影响油气、化工成本和通胀预期"],
      ["A股宽度", `上涨${breadth.up}/下跌${breadth.down}`, "决定外部映射能否转为真实交易机会"]
    ]
  };
}

function buildModuleHealth() {
  return [
    ["01 市场阶段", "指数、成交额、涨跌家数、涨跌停", "历史阶段回测未接入", "可形成当日市场阶段结论"],
    ["02 宏观政策全球", "美股、黄金、原油、美元人民币", "央行日历、CPI/PCE/FOMC自动日历未接入", "只给方向映射，不直接给个股结论"],
    ["03 行业主线", "东方财富行业板块；失败时用新浪行业成分股聚合", "产业链上下游和市场份额库未接入", "可输出今日强弱行业和来源口径"],
    ["04 公司基本面", "利润表、资产负债表、现金流量表、行情估值、F10公司资料、概念标签", "公司治理深度数据未接入", "可做基础财报和公司画像加减分"],
    ["05 财报公告雷达", "候选股最近公告、财报披露日期、公告标题分类、PDF原文链接", "公告正文自动摘要未接入", "可给标题级预警并提供原文复核入口"],
    ["06 估值质量", "PE/PB、市值、收入、利润、现金流、负债率", "同行估值分位、DCF/三情景估值未接入", "可做估值和质量初筛"],
    ["07 买卖点触发系统", "复权日K、30分钟K、均线、20日高低、30分钟中位确认、类一/二/三买观察", "5分钟K、笔、线段、中枢/背驰自动识别未完成", "可给近似买卖点、建仓、加仓、止损、止盈触发条件"],
    ["08 资金情绪", "涨跌家数、涨跌停、板块强弱、成交额", "连板晋级率、炸板率、龙虎榜/融资/北向未接入", "可判断情绪强弱"],
    ["09 候选池评分", "行情+财报+公告+日K综合评分", "用户确认工作流待强化", "可输出观察池、验证点和风险"],
    ["10 组合仓位", "本地持仓输入", "真实持仓、成本、计划必须用户提供", "录入后才能个性化"],
    ["11 交易纪律复盘", "今日系统判断和验证点", "历史建议库、月/季复盘样本未接入", "先做日志，后做周期修复"],
    ["12 历史多倍股", "保留方法论入口", "历史5倍/10倍股和失败样本库未接入", "暂不作为量化结论"],
    ["13 综合矩阵", "市场、宏观、行业、财报、公告、技术、候选池信号", "历史传导准确率回测未接入", "可给综合影响方向和冲突降级"]
  ];
}

function buildDataGaps() {
  return [
    { area: "用户持仓", reason: "成本、仓位、买入理由、止损止盈计划属于私人数据，无法从公开源获取", fix: "第10章录入后进入组合、技术跟踪、复盘和风险预警" },
    { area: "公告正文自动摘要", reason: "当前已取得公告标题、分类和PDF原文链接，但尚未解析PDF正文条款", fix: "下一步增加PDF文本抽取、风险条款和金额字段识别" },
    { area: "严格缠论结构", reason: "已接入日K和30分钟K，但笔、线段、中枢和背驰算法仍需完善", fix: "继续实现多级别笔/线段/中枢识别并保留人工复核入口" },
    { area: "产业链与龙头数据库", reason: "行业涨跌与公司概念已接入，但上下游、份额、核心客户仍需要知识库或第三方数据", fix: "建立芯片、AI、资源等产业链结构库" },
    { area: "历史多倍股样本", reason: "需要批量复权行情、财报、行业、政策事件和失败样本库", fix: "单独建立样本库后用于第12章规则校验" }
  ];
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const [sinaIndexRows, globalRows] = await Promise.all([
    guarded("新浪A股指数", () => fetchSinaQuotes(["sh000001", "sz399001", "sz399006", "sh000300", "sh000688"]), []),
    guarded("新浪全球资产", () => fetchSinaQuotes(["gb_dji", "gb_ixic", "gb_inx", "hf_GC", "hf_CL", "USDCNY"]), [])
  ]);
  const eastmoneyRows = await guarded("东方财富全A行情", () => fetchEastmoneyPaged({ fsExpr: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23", pageSize: 100, order: 1, sort: "f3" }), []);
  const topSectorRows = await guarded("东方财富行业领涨", () => fetchEastmoneyList({ fsExpr: "m:90+t:2", pageSize: 30, order: 1, sort: "f3", fields: "f12,f14,f2,f3,f4,f5,f6,f8,f20" }), []);
  const bottomSectorRows = await guarded("东方财富行业领跌", () => fetchEastmoneyList({ fsExpr: "m:90+t:2", pageSize: 30, order: 0, sort: "f3", fields: "f12,f14,f2,f3,f4,f5,f6,f8,f20" }), []);

  const indices = sinaIndexRows.map(normalizeIndex);
  const globalAssets = globalRows.map(normalizeGlobal);
  let dataScope = "eastmoney-full-market";
  let stocks = eastmoneyRows.map(normalizeStock);
  if (!stocks.length) {
    dataScope = "sina-full-market";
    stocks = await guarded("新浪全A行情", fetchSinaAllAStocks, []);
  }
  if (!stocks.length) {
    dataScope = "fallback-watchlist";
    const cached = loadFullMarketCache();
    if (cached?.stocks?.topGainers?.length && cached?.audit?.stocks > 1000) {
      fs.writeFileSync(SNAPSHOT_JSON, JSON.stringify({
        ...cached,
        version: `${cached.version}-cached`,
        generatedAt: new Date().toISOString(),
        generatedAtChina: todayChina(),
        dataScope: "cached-full-market",
        dataScopeNote: `缓存全市场口径：实时全市场源失败，使用最近一次全市场快照（原时间 ${cached.generatedAtChina}）`,
        audit: { ...cached.audit, dataScope: "cached-full-market", sourceFailures: audit.failures.length }
      }, null, 2), "utf8");
      const cachedSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_JSON, "utf8"));
      fs.writeFileSync(SNAPSHOT_JS, `window.STOCK_ASSISTANT_DATA = ${JSON.stringify(cachedSnapshot, null, 2)};\n`, "utf8");
      fs.writeFileSync(AUDIT_JSON, JSON.stringify(audit, null, 2), "utf8");
      console.log("Used cached full-market snapshot because live full-market sources failed.");
      return;
    }
    stocks = await guarded("新浪候选观察名单行情", fetchFallbackStocks, []);
    audit.failures.push({ name: "全市场行情降级", error: "东方财富和新浪全A行情均不可用，且没有可用全市场缓存，本次使用候选观察名单，不代表全市场扫描" });
  }
  const breadth = buildBreadth(stocks);
  const turnoverYi = round(stocks.reduce((sum, s) => sum + (s.amountYi || 0), 0), 2);
  let sectors = {
    top: topSectorRows.map(r => ({ code: r.f12, name: r.f14, price: round(r.f2), pct: round(r.f3), amountYi: yi(r.f6), turnover: round(r.f8), marketCapYi: yi(r.f20) })),
    bottom: bottomSectorRows.map(r => ({ code: r.f12, name: r.f14, price: round(r.f2), pct: round(r.f3), amountYi: yi(r.f6), turnover: round(r.f8), marketCapYi: yi(r.f20) }))
  };
  if (!sectors.top.length || !sectors.bottom.length) {
    sectors = await guarded("新浪行业板块聚合", fetchSinaIndustrySectors, sectors);
  }
  const baseCandidates = buildCandidates(stocks);
  const candidates = await enrichCandidates(baseCandidates);
  const phase = marketPhase(indices, breadth, turnoverYi);
  const events = buildEvents(indices, sectors, globalAssets, breadth, candidates);
  const macroSummary = buildMacroSummary(globalAssets, indices, breadth);

  audit.coverage = {
    dataScope,
    tradingPreference: TRADING_PREFERENCES.focusAreas.join("、"),
    stocks: stocks.length,
    breadthTotal: breadth.total,
    candidates: candidates.length,
    candidatesWithFinancial: candidates.filter(c => c.financial?.reportDate).length,
    candidatesWithAnnouncements: candidates.filter(c => c.announcements?.latest?.length).length,
    candidatesWithKline: candidates.filter(c => c.technical?.lastDate).length,
    candidatesWithMinuteKline: candidates.filter(c => c.technical?.minute?.lastDate).length,
    candidatesWithCompanyProfile: candidates.filter(c => c.companyProfile?.orgName).length,
    candidatesWithAnnouncementPdf: candidates.filter(c => (c.announcements?.latest || []).some(a => a.pdfUrl)).length,
    tradeStates: candidates.reduce((acc, c) => {
      const state = c.tradePlan?.state || "观察池";
      acc[state] = (acc[state] || 0) + 1;
      return acc;
    }, {}),
    sectorSource: sectors.top[0]?.source || "东方财富行业板块行情",
    sourceFailures: audit.failures.length
  };

  const snapshot = {
    version: "0.3-engineered-snapshot",
    generatedAt: new Date().toISOString(),
    generatedAtChina: todayChina(),
    sources: [
      { name: "新浪财经实时行情", url: "https://finance.sina.com.cn/" },
      { name: "新浪财经Market Center全A行情", url: "https://vip.stock.finance.sina.com.cn/" },
      { name: "东方财富沪深京A股行情", url: "https://quote.eastmoney.com/" },
      { name: "东方财富行业板块行情", url: "https://quote.eastmoney.com/center/boardlist.html" },
      { name: "东方财富财务报表", url: "https://data.eastmoney.com/" },
      { name: "东方财富公告", url: "https://data.eastmoney.com/notices/" },
      { name: "东方财富复权日K", url: "https://quote.eastmoney.com/" },
      { name: "新浪财经日K/分钟K备用源", url: "https://money.finance.sina.com.cn/" },
      { name: "新浪财经行业节点", url: "https://vip.stock.finance.sina.com.cn/" },
      { name: "东方财富F10公司资料", url: "https://data.eastmoney.com/" }
    ],
    dataScope,
    dataScopeNote: dataScope === "fallback-watchlist" ? "降级口径：仅候选观察名单，不能代表全市场宽度和全市场候选池" : `全市场扫描口径：${dataScope === "sina-full-market" ? "新浪财经Market Center备用源" : "东方财富主源"}`,
    market: { phase, indices, breadth, turnoverYi },
    macroSummary,
    globalAssets,
    sectors,
    stocks: {
      topGainers: stocks.slice(0, 30),
      topLosers: [...stocks].sort((a, b) => a.pct - b.pct).slice(0, 30),
      highAmount: [...stocks].sort((a, b) => (b.amountYi || 0) - (a.amountYi || 0)).slice(0, 30)
    },
    candidates,
    events,
    moduleHealth: buildModuleHealth(),
    dataGaps: buildDataGaps(),
    audit: audit.coverage
  };

  if (!stocks.length) {
    fs.writeFileSync(AUDIT_JSON, JSON.stringify(audit, null, 2), "utf8");
    throw new Error("没有取得任何股票行情，已阻止覆盖快照。请检查数据源连接。");
  }

  fs.writeFileSync(SNAPSHOT_JSON, JSON.stringify(snapshot, null, 2), "utf8");
  fs.writeFileSync(SNAPSHOT_JS, `window.STOCK_ASSISTANT_DATA = ${JSON.stringify(snapshot, null, 2)};\n`, "utf8");
  if (stocks.length > 1000) {
    fs.writeFileSync(FULL_SNAPSHOT_JSON, JSON.stringify(snapshot, null, 2), "utf8");
  }
  fs.writeFileSync(AUDIT_JSON, JSON.stringify(audit, null, 2), "utf8");
  console.log(`Wrote ${SNAPSHOT_JS}`);
  console.log(JSON.stringify({ phase, stocks: stocks.length, breadth, candidates: candidates.length, audit: audit.coverage }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
