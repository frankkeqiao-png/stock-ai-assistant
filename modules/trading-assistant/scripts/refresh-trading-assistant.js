const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SNAPSHOT_JSON = path.join(DATA_DIR, "trading-assistant.json");
const SNAPSHOT_JS = path.join(DATA_DIR, "trading-assistant.js");
const UNIVERSE_CACHE_JSON = path.join(DATA_DIR, "trading-assistant-universe-cache.json");
const STRATEGY_LOG_JSON = path.join(DATA_DIR, "trading-assistant-strategy-log.json");
const REMOVAL_STATE_JSON = path.join(DATA_DIR, "trading-assistant-removal-state.json");
const RECOMMENDATION_TRACKING_JSON = path.join(DATA_DIR, "trading-assistant-recommendation-tracking.json");

const audit = {
  generatedAt: new Date().toISOString(),
  sources: [],
  failures: [],
  coverage: {}
};

const SECTOR_CONFIG = [
  {
    name: "科技",
    priority: 100,
    candidateQuota: 16,
    boardQuota: 16,
    keywords: ["半导体", "芯片", "集成电路", "电子", "软件", "计算机", "通信", "光模块", "算力", "人工智能", "AI", "数据中心", "服务器", "网络安全", "消费电子", "PCB", "元器件", "存储", "先进封装", "互联网", "数据要素", "云计算", "信创"]
  },
  {
    name: "新能源/电力设备",
    priority: 88,
    candidateQuota: 3,
    boardQuota: 8,
    keywords: ["锂", "锂电", "电池", "储能", "新能源", "固态电池", "钠电池", "光伏", "逆变器", "电网", "智能电网", "电力设备", "发电设备", "电器", "风电"]
  },
  {
    name: "机器人/智能制造",
    priority: 74,
    candidateQuota: 3,
    boardQuota: 4,
    keywords: ["机器人", "人形机器人", "智能制造", "自动化", "工业母机", "数控", "工业软件"]
  },
  {
    name: "低空经济/航空航天",
    priority: 72,
    candidateQuota: 3,
    boardQuota: 4,
    keywords: ["低空经济", "无人机", "航空", "航天", "卫星", "北斗", "商业航天"]
  },
  {
    name: "高端制造/汽车",
    priority: 70,
    candidateQuota: 3,
    boardQuota: 5,
    keywords: ["汽车", "新能源车", "汽车零部件", "机械", "工程机械", "通用设备", "专用设备", "仪器仪表", "船舶", "设备"]
  },
  {
    name: "医药医疗",
    priority: 62,
    candidateQuota: 3,
    boardQuota: 5,
    keywords: ["医药", "医疗", "生物", "创新药", "中药", "化学制药", "医疗器械", "CXO", "疫苗"]
  },
  {
    name: "军工国防",
    priority: 58,
    candidateQuota: 3,
    boardQuota: 4,
    keywords: ["军工", "国防", "航天", "航空", "北斗", "卫星", "船舶制造"]
  },
  {
    name: "黄金/贵金属",
    priority: 56,
    candidateQuota: 3,
    boardQuota: 3,
    keywords: ["黄金", "贵金属", "白银"]
  },
  {
    name: "资源周期/化工",
    priority: 54,
    candidateQuota: 3,
    boardQuota: 5,
    keywords: ["有色", "稀土", "小金属", "化工", "化学", "石油", "油气", "资源", "煤炭", "钢铁", "材料", "新材料"]
  },
  {
    name: "大消费",
    priority: 46,
    candidateQuota: 3,
    boardQuota: 4,
    keywords: ["消费", "食品", "饮料", "白酒", "家电", "家居", "旅游", "酒店", "免税", "商业百货"]
  }
];

const FOCUS = {
  focus: SECTOR_CONFIG.map(s => s.name),
  include: [...new Set(SECTOR_CONFIG.flatMap(s => s.keywords))],
  primarySector: "科技"
};

const EXCLUDE_BOARD_KEYWORDS = ["ST", "退市", "风险警示", "B股", "基金", "债券", "港股", "美股", "银行", "保险", "证券", "金融", "房地产", "地产", "建筑", "建材", "水泥", "工程建设", "跨境电商", "外贸", "农业", "种业", "养殖", "猪肉", "鸡肉", "水产", "农林牧渔", "公用", "环保", "水务", "燃气", "交通运输", "物流", "港口", "机场", "高速", "教育", "人力资源", "文化传媒", "影视", "游戏"];
const EXCLUDE_STOCK_TEXT_KEYWORDS = ["银行", "保险", "证券", "房地产", "地产", "建筑", "建材", "水泥", "跨境电商", "外贸", "农业", "种业", "养殖", "猪肉", "鸡肉", "水产", "农林牧渔", "公用", "环保", "水务", "燃气", "交通运输", "物流", "港口", "机场", "高速", "教育", "人力资源", "文化传媒", "影视", "游戏"];

function classifySectorText(text) {
  const source = String(text || "");
  let best = null;
  for (const sector of SECTOR_CONFIG) {
    const hits = sector.keywords.filter(k => source.includes(k));
    if (!hits.length) continue;
    const score = sector.priority + hits.length * 3;
    if (!best || score > best.score) best = { sector: sector.name, hits, score, priority: sector.priority };
  }
  return best || { sector: "其它", hits: [], score: 0, priority: 0 };
}

const WATCHLIST = [
  "300750", "002594", "300014", "002812", "002459", "300274", "688599", "688041",
  "688981", "688012", "688008", "688256", "300308", "300394", "300502", "603986",
  "002371", "300476", "002463", "300124", "300316", "688111", "002156", "300450"
];

const SECTOR_SEED_CODES = {
  "黄金/贵金属": ["601899", "600547", "600489", "000975", "002155"],
  "资源周期/化工": ["600309", "600111", "002460", "603799", "000983"],
  "大消费": ["600519", "000858", "000333", "600887", "603288"]
};

function round(value, digits = 2) {
  if (value === null || value === undefined || value === "" || value === "-" || Number.isNaN(Number(value))) return null;
  return Number(Number(value).toFixed(digits));
}

function yi(value) {
  if (value === null || value === undefined || value === "" || value === "-" || Number.isNaN(Number(value))) return null;
  return round(Number(value) / 100000000, 2);
}

function pct(value) {
  return round(value, 2);
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

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 20000);
  try {
    const res = await fetch(url, {
      method: options.method || "GET",
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 stock-ai-trading-assistant/0.1",
        "referer": options.referer || "https://finance.sina.com.cn/",
        ...(options.headers || {})
      },
      body: options.body
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

function fetchJsonViaPowerShell(url) {
  return new Promise((resolve, reject) => {
    const script = [
      "$ErrorActionPreference='Stop'",
      `$url=${JSON.stringify(url)}`,
      "$headers=@{Referer='https://quote.eastmoney.com/'; 'User-Agent'='Mozilla/5.0'}",
      "$r=Invoke-WebRequest -UseBasicParsing -Uri $url -Headers $headers -TimeoutSec 60",
      "Write-Output $r.Content"
    ].join("; ");
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      timeout: 75000,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function fetchJsonViaCurl(url) {
  return new Promise((resolve, reject) => {
    execFile("curl.exe", ["-L", "--retry", "2", "--retry-delay", "1", "--connect-timeout", "15", "--max-time", "35", "-sS", "-H", "Referer: https://quote.eastmoney.com/", "-H", "User-Agent: Mozilla/5.0", url], {
      windowsHide: true,
      timeout: 45000,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      try {
        const start = stdout.indexOf("{");
        const end = stdout.lastIndexOf("}");
        resolve(JSON.parse(start >= 0 && end >= start ? stdout.slice(start, end + 1) : stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function cleanError(error) {
  const text = String(error?.message || error || "");
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.find(line => !line.includes("% Total") && !line.includes("Dload") && !line.includes("Speed")) || text.slice(0, 180);
}

async function withRetry(fn, attempts = 2, delayMs = 700) {
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
    audit.sources.push({ name, ok: false, error: cleanError(error) });
    audit.failures.push({ name, error: cleanError(error) });
    return fallback;
  }
}

function eastmoneyUrl({ fsExpr, pageSize = 100, page = 1, order = 1, sort = "f3", fields }) {
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
  const json = await fetchJson(eastmoneyUrl(args), { referer: "https://quote.eastmoney.com/", timeout: 30000 });
  return json?.data?.diff || [];
}

async function fetchEastmoneyPaged(args) {
  const first = await fetchJson(eastmoneyUrl({ ...args, page: 1 }), { referer: "https://quote.eastmoney.com/", timeout: 30000 });
  const rows = [...(first?.data?.diff || [])];
  const total = first?.data?.total || rows.length;
  const pages = Math.ceil(total / (args.pageSize || 100));
  for (let page = 2; page <= pages; page += 1) {
    const json = await fetchJson(eastmoneyUrl({ ...args, page }), { referer: "https://quote.eastmoney.com/", timeout: 30000 });
    rows.push(...(json?.data?.diff || []));
  }
  return rows;
}

function normalizeQuote(row) {
  return {
    code: String(row.f12 || ""),
    name: row.f14 || "",
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

function sinaSymbol(code) {
  return `${code.startsWith("6") ? "sh" : "sz"}${code}`;
}

function tencentSymbol(code) {
  return `${code.startsWith("6") ? "sh" : "sz"}${code}`;
}

async function fetchTencentQuoteMetrics(codes) {
  const symbols = codes.map(tencentSymbol);
  const text = await fetchText(`https://qt.gtimg.cn/q=${symbols.join(",")}`, {
    referer: "https://gu.qq.com/",
    timeout: 16000
  });
  const metrics = {};
  for (const line of text.split(/\r?\n/)) {
    const start = line.indexOf("\"");
    const end = line.lastIndexOf("\"");
    if (start < 0 || end <= start) continue;
    const values = line.slice(start + 1, end).split("~");
    const code = values[2];
    if (!code) continue;
    metrics[code] = {
      turnover: round(values[38]),
      pe: round(values[39]),
      amplitude: round(values[43]),
      marketCapYi: round(values[45])
    };
  }
  return metrics;
}

function normalizeSinaStock(row) {
  const v = row.values;
  const code = row.symbol.slice(2);
  const current = Number(v[3]);
  const prev = Number(v[2]);
  return {
    code,
    name: v[0],
    price: round(current),
    pct: prev ? round((current - prev) / prev * 100) : null,
    change: prev ? round(current - prev) : null,
    amountYi: yi(v[9]),
    volumeHands: Number(v[8]) / 100,
    high: round(v[4]),
    low: round(v[5]),
    open: round(v[1]),
    prevClose: round(prev),
    turnover: null,
    pe: null,
    pb: null,
    mainNetInflowYi: null
  };
}

async function fetchFallbackWatchlist() {
  const rows = await fetchSinaQuotes(WATCHLIST.map(sinaSymbol));
  return rows.filter(r => r.values?.[0] && Number(r.values?.[3]) > 0).map(normalizeSinaStock);
}

function normalizeIndex(row) {
  const v = row.values;
  const current = Number(v[3]);
  const prev = Number(v[2]);
  return {
    symbol: row.symbol,
    name: v[0],
    current: round(current),
    pct: prev ? round((current - prev) / prev * 100) : null,
    amountYi: yi(v[9]),
    time: `${v[30] || ""} ${v[31] || ""}`.trim()
  };
}

async function fetchBoards(type) {
  const fsExpr = type === "concept" ? "m:90+t:3" : "m:90+t:2";
  const fields = "f12,f14,f2,f3,f4,f5,f6,f8,f20";
  return fetchEastmoneyPaged({ fsExpr, pageSize: 100, order: 1, sort: "f3", fields });
}

function boardMatches(name) {
  const text = String(name || "");
  if (EXCLUDE_BOARD_KEYWORDS.some(k => text.includes(k))) return false;
  return classifySectorText(text).sector !== "其它";
}

function selectBoardsBySector(items, maxTotal = 52) {
  const buckets = new Map();
  for (const item of items) {
    const cls = classifySectorText(item.name);
    if (cls.sector === "其它") continue;
    const sector = SECTOR_CONFIG.find(s => s.name === cls.sector);
    const enriched = { ...item, sector: cls.sector, sectorPriority: cls.priority, sectorHits: cls.hits };
    if (!buckets.has(cls.sector)) buckets.set(cls.sector, []);
    buckets.get(cls.sector).push(enriched);
  }
  const selected = [];
  for (const sector of SECTOR_CONFIG) {
    const rows = (buckets.get(sector.name) || [])
      .sort((a, b) => (b.amountYi || 0) - (a.amountYi || 0) || String(a.name).localeCompare(String(b.name), "zh-Hans-CN"))
      .slice(0, sector.boardQuota);
    selected.push(...rows);
  }
  return selected
    .sort((a, b) => (b.sectorPriority || 0) - (a.sectorPriority || 0) || (b.amountYi || 0) - (a.amountYi || 0))
    .slice(0, maxTotal);
}

async function fetchBoardMembers(boardCode) {
  const fields = "f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f14,f15,f16,f17,f18,f20,f21,f23,f62";
  const rows = await fetchEastmoneyPaged({
    fsExpr: `b:${boardCode}`,
    pageSize: 100,
    order: 1,
    sort: "f6",
    fields
  });
  return rows.map(normalizeQuote).filter(s => s.code && s.name);
}

async function buildFocusUniverse() {
  const [industryBoards, conceptBoards] = await Promise.all([
    guarded("东方财富行业板块", () => fetchBoards("industry"), []),
    guarded("东方财富概念板块", () => fetchBoards("concept"), [])
  ]);

  const boards = selectBoardsBySector([...industryBoards, ...conceptBoards]
    .map(b => ({ code: b.f12, name: b.f14, pct: round(b.f3), amountYi: yi(b.f6), turnover: round(b.f8) }))
    .filter(b => b.code && b.name && boardMatches(b.name)), 80);

  const stockMap = new Map();
  for (const board of boards) {
    const members = await guarded(`东方财富板块成分 ${board.name}`, () => fetchBoardMembers(board.code), []);
    for (const stock of members) {
      if (/ST|退/.test(stock.name)) continue;
      const current = stockMap.get(stock.code) || { ...stock, boards: [], sectorScores: {} };
      current.boards.push({ name: board.name, code: board.code, pct: board.pct, amountYi: board.amountYi, sector: board.sector });
      current.sectorScores[board.sector] = (current.sectorScores[board.sector] || 0) + 1;
      stockMap.set(stock.code, current);
    }
  }

  return {
    boards,
    stocks: [...stockMap.values()]
  };
}

async function fetchSinaFocusUniverse() {
  const text = await fetchText("https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodes", {
    referer: "https://vip.stock.finance.sina.com.cn/",
    timeout: 22000
  });
  const root = Function(`return ${text}`)();
  const nodes = [];
  function walk(item, group = "") {
    if (!Array.isArray(item)) return;
    const name = String(item[0] || "").replace(/<[^>]+>/g, "");
    const children = item[1];
    const node = item[3] || item[2];
    const nextGroup = ["新浪行业", "申万行业", "申万一级", "申万二级", "申万三级", "热门概念", "概念板块"].includes(name) ? name : group;
    if (nextGroup && typeof node === "string" && node && !["sinahy", "swhy", "sw1_hy", "sw2_hy", "sw3_hy", "ch_gn", "gainianbankuai"].includes(node)) {
      nodes.push({ name, node, group: nextGroup });
    }
    if (Array.isArray(children)) for (const child of children) walk(child, nextGroup);
  }
  walk(root);

  const boards = selectBoardsBySector(nodes
    .filter(n => n.node && boardMatches(n.name))
    .map(n => ({ code: n.node, name: n.name, pct: null, amountYi: null, turnover: null, source: `新浪财经${n.group}` })), 45);

  const stockMap = new Map();
  async function loadBoard(board) {
    const members = await guarded(`新浪板块成分 ${board.name}`, () => fetchSinaNodeMembers(board.code), []);
    const validMembers = members.filter(s => s.price && Number.isFinite(Number(s.pct)));
    const totalAmount = validMembers.reduce((sum, s) => sum + (s.amountYi || 0), 0);
    const avgPct = validMembers.length
      ? validMembers.reduce((sum, s) => sum + Number(s.pct || 0), 0) / validMembers.length
      : null;
    const weightedPct = totalAmount > 0
      ? validMembers.reduce((sum, s) => sum + Number(s.pct || 0) * (s.amountYi || 0), 0) / totalAmount
      : avgPct;
    board.pct = round(weightedPct);
    board.amountYi = round(totalAmount);
    board.turnover = validMembers.length ? round(validMembers.reduce((sum, s) => sum + Number(s.turnover || 0), 0) / validMembers.length) : null;
    board.memberCount = validMembers.length;
    board.derived = true;
    return members.map(stock => ({ stock, board }));
  }

  const batches = [];
  for (let i = 0; i < boards.length; i += 5) batches.push(boards.slice(i, i + 5));
  for (const batch of batches) {
    const boardMembers = (await Promise.all(batch.map(loadBoard))).flat();
    for (const { stock, board } of boardMembers) {
      if (/ST|退/.test(stock.name)) continue;
      const current = stockMap.get(stock.code) || { ...stock, boards: [], sectorScores: {} };
      current.boards.push(board);
      current.sectorScores[board.sector] = (current.sectorScores[board.sector] || 0) + 1;
      stockMap.set(stock.code, current);
    }
  }
  return { boards, stocks: [...stockMap.values()] };
}

async function fetchSinaNodeMembers(node) {
  const all = [];
  for (let page = 1; page <= 5; page += 1) {
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=80&sort=symbol&asc=1&node=${encodeURIComponent(node)}&symbol=&_s_r_a=init`;
    const text = await fetchText(url, { referer: "https://vip.stock.finance.sina.com.cn/", timeout: 22000 });
    const rows = Function(`return ${text}`)();
    if (!Array.isArray(rows) || !rows.length) break;
    all.push(...rows.map(normalizeSinaNodeStock));
    if (rows.length < 80) break;
  }
  return all;
}

function normalizeSinaNodeStock(row) {
  const price = Number(row.trade);
  const prev = Number(row.settlement);
  return {
    code: String(row.code || ""),
    name: row.name || "",
    price: round(price),
    pct: round(row.changepercent),
    change: round(row.pricechange),
    volumeHands: Number(row.volume || 0) / 100,
    amountYi: yi(row.amount),
    amplitude: null,
    turnover: round(row.turnoverratio),
    pe: round(row.per),
    volumeRatio: null,
    high: round(row.high),
    low: round(row.low),
    open: round(row.open),
    prevClose: round(prev),
    marketCapYi: yi(Number(row.mktcap || 0) * 10000),
    floatCapYi: yi(Number(row.nmc || 0) * 10000),
    pb: round(row.pb),
    mainNetInflowYi: null
  };
}

function secid(code) {
  return `${code.startsWith("6") ? "1" : "0"}.${code}`;
}

async function fetchKline(code, klt = 101, limit = 180) {
  const params = new URLSearchParams({
    secid: secid(code),
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    klt: String(klt),
    fqt: "1",
    lmt: String(limit),
    end: "20500101"
  });
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?${params.toString()}`;
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

async function fetchSinaKline(code, scale = 240, limit = 160) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sinaSymbol(code)}&scale=${scale}&ma=no&datalen=${limit}`;
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

async function fetchTencentKline(code, klt = 101, limit = 160) {
  const symbol = tencentSymbol(code);
  const url = klt === 101
    ? `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${limit},qfq`
    : `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${symbol},m${klt},,${limit}`;
  const json = await fetchJson(url, { referer: "https://gu.qq.com/", timeout: 22000 });
  const bucket = json?.data?.[symbol] || {};
  const rows = klt === 101
    ? (bucket.qfqday || bucket.day || [])
    : (bucket[`m${klt}`] || []);
  return (Array.isArray(rows) ? rows : []).map(r => ({
    date: r[0],
    open: round(r[1]),
    close: round(r[2]),
    high: round(r[3]),
    low: round(r[4]),
    volume: Number(r[5]),
    amountYi: null,
    amplitude: null,
    pct: null,
    change: null,
    turnover: null
  }));
}

async function fetchKlineWithFallback(code, klt = 101, limit = 180) {
  try {
    const rows = await fetchKline(code, klt, limit);
    if (rows.length) {
      audit.sources.push({ name: `东方财富K线源 ${code} klt=${klt}`, ok: true });
      return rows;
    }
    throw new Error("empty kline");
  } catch (eastError) {
    audit.sources.push({ name: `东方财富K线源 ${code} klt=${klt}`, ok: false, error: cleanError(eastError) });
  }

  const scale = klt === 101 ? 240 : klt;
  try {
    const rows = await fetchSinaKline(code, scale, Math.min(limit, 160));
    if (rows.length) {
      audit.sources.push({ name: `新浪K线备用源 ${code} scale=${scale}`, ok: true });
      return rows;
    }
    throw new Error("empty kline");
  } catch (sinaError) {
    audit.sources.push({ name: `新浪K线备用源 ${code} scale=${scale}`, ok: false, error: cleanError(sinaError) });
  }

  const tencentRows = await fetchTencentKline(code, klt, Math.min(limit, 160));
  if (tencentRows.length) {
    audit.sources.push({ name: `腾讯K线第二备用源 ${code} klt=${klt}`, ok: true });
    return tencentRows;
  }
  throw new Error(`all kline sources unavailable for ${code} klt=${klt}`);
}

async function fetchReport(code, reportName) {
  const params = new URLSearchParams({
    reportName,
    columns: "ALL",
    filter: `(SECURITY_CODE="${code}")`,
    pageNumber: "1",
    pageSize: "4",
    sortColumns: "REPORT_DATE",
    sortTypes: "-1"
  });
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?${params.toString()}`;
  const json = await fetchJson(url, { referer: "https://data.eastmoney.com/", timeout: 22000 });
  return json?.result?.data || [];
}

async function fetchAnnouncements(code) {
  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=6&page_index=1&ann_type=A&client_source=web&stock_list=${code}`;
  const json = await fetchJson(url, { referer: "https://data.eastmoney.com/notices/", timeout: 22000 });
  return (json?.data?.list || []).map(a => ({
    title: a.title_ch || a.title || "",
    date: String(a.notice_date || a.display_time || "").slice(0, 10),
    type: (a.columns || []).map(c => c.column_name).join("、") || "公告",
    artCode: a.art_code,
    url: a.art_code ? `https://data.eastmoney.com/notices/detail/${code}/${a.art_code}.html` : ""
  }));
}

let cninfoStockListCache = null;

async function fetchCninfoStockList() {
  if (cninfoStockListCache) return cninfoStockListCache;
  const json = await fetchJson("http://www.cninfo.com.cn/new/data/szse_stock.json", {
    referer: "http://www.cninfo.com.cn/new/index",
    timeout: 22000
  });
  cninfoStockListCache = Array.isArray(json?.stockList) ? json.stockList : [];
  return cninfoStockListCache;
}

async function fetchCninfoAnnouncements(code) {
  const stockList = await fetchCninfoStockList();
  const item = stockList.find(row => row.code === code);
  if (!item?.orgId) throw new Error(`cninfo orgId not found for ${code}`);
  const body = new URLSearchParams({
    stock: `${code},${item.orgId}`,
    tabName: "fulltext",
    pageSize: "6",
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
  const text = await fetchText("http://www.cninfo.com.cn/new/hisAnnouncement/query", {
    method: "POST",
    referer: "http://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure/list/search",
    timeout: 22000,
    body,
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
  });
  const json = JSON.parse(text);
  return (json?.announcements || []).map(a => ({
    title: String(a.announcementTitle || "").replace(/<[^>]+>/g, ""),
    date: String(a.announcementTime ? new Date(a.announcementTime).toISOString().slice(0, 10) : ""),
    type: "公告",
    artCode: a.announcementId,
    url: a.adjunctUrl ? `http://static.cninfo.com.cn/${a.adjunctUrl}` : "",
    source: "巨潮资讯公告"
  }));
}

async function fetchAnnouncementsWithFallback(code) {
  try {
    const rows = await fetchAnnouncements(code);
    if (rows.length) {
      audit.sources.push({ name: `东方财富公告源 ${code}`, ok: true });
      return rows.map(row => ({ ...row, source: "东方财富公告" }));
    }
    throw new Error("empty announcements");
  } catch (eastError) {
    audit.sources.push({ name: `东方财富公告源 ${code}`, ok: false, error: cleanError(eastError) });
  }

  const rows = await fetchCninfoAnnouncements(code);
  if (rows.length) {
    audit.sources.push({ name: `巨潮资讯公告备用源 ${code}`, ok: true });
    return rows;
  }
  throw new Error(`all announcement sources unavailable for ${code}`);
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
    industryPath: r.EM2016 || "",
    concepts: String(r.BLGAINIAN || "").split(",").filter(Boolean).slice(0, 10),
    region: r.REGIONBK || "",
    profile: String(r.ORG_PROFIE || "").replace(/\s+/g, " ").trim().slice(0, 180)
  };
}

async function fetchCapitalFlow(code) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${secid(code)}&lmt=1&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63`;
  let json;
  try {
    json = await fetchJson(url, { referer: "https://quote.eastmoney.com/", timeout: 22000 });
  } catch {
    try {
      json = await fetchJsonViaPowerShell(url);
    } catch {
      json = null;
    }
  }
  const line = json?.data?.klines?.[0];
  if (!line) {
    return fetchCapitalFlowRealtimeWithFallback(code);
  }
  const [date, main, small, medium, large, superLarge, mainPct, smallPct, mediumPct, largePct, superLargePct] = line.split(",");
  return {
    source: "东方财富资金流",
    status: "已取得",
    date,
    mainNetInflowYi: yi(main),
    smallNetInflowYi: yi(small),
    mediumNetInflowYi: yi(medium),
    largeNetInflowYi: yi(large),
    superLargeNetInflowYi: yi(superLarge),
    mainNetInflowPct: round(mainPct),
    largeNetInflowPct: round(largePct),
    superLargeNetInflowPct: round(superLargePct)
  };
}

async function fetchCapitalFlowRealtimeWithFallback(code) {
  try {
    return await fetchCapitalFlowRealtime(code);
  } catch (eastError) {
    audit.sources.push({ name: `东方财富实时资金字段 ${code}`, ok: false, error: cleanError(eastError) });
    return await fetchSinaCapitalFlow(code, cleanError(eastError));
  }
}

async function fetchCapitalFlowRealtime(code) {
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secid(code)}&fields=f12,f14,f2,f3,f6,f8,f9,f23,f62,f184`;
  const json = await fetchJsonViaCurl(url);
  const row = json?.data?.diff?.[0];
  if (!row || row.f62 === null || row.f62 === undefined || row.f62 === "-") {
    return fetchSinaCapitalFlow(code, "东方财富历史资金流和实时字段均未返回主力净流入");
  }
  return {
    source: "东方财富实时行情资金字段",
    status: "已取得",
    date: todayChina().slice(0, 10).replace(/\//g, "-"),
    mainNetInflowYi: yi(row.f62),
    mainNetInflowPct: round(row.f184)
  };
}

let sinaCapitalFlowPromise = null;

async function fetchSinaCapitalFlowMarket() {
  const map = new Map();
  const pages = Array.from({ length: 65 }, (_, index) => index + 1);
  for (let i = 0; i < pages.length; i += 8) {
    const batch = pages.slice(i, i + 8);
    const results = await Promise.all(batch.map(async page => {
      const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_ssggzj?page=${page}&num=100`;
      const text = await fetchText(url, {
        referer: "https://vip.stock.finance.sina.com.cn/moneyflow/",
        timeout: 22000
      });
      const rows = Function(`return ${text}`)();
      return Array.isArray(rows) ? rows : [];
    }));
    for (const row of results.flat()) {
      const code = String(row.symbol || "").slice(-6);
      if (code) map.set(code, row);
    }
  }
  return map;
}

async function fetchSinaCapitalFlow(code, previousError = "") {
  if (!sinaCapitalFlowPromise) sinaCapitalFlowPromise = fetchSinaCapitalFlowMarket();
  const market = await sinaCapitalFlowPromise;
  const row = market.get(code);
  if (!row) {
    return {
      source: "东方财富资金流 / 新浪资金流",
      status: "资金流缺失",
      mainNetInflowYi: null,
      reason: previousError ? `东方财富失败：${previousError}；新浪资金流未匹配到该股票` : "新浪资金流未匹配到该股票"
    };
  }
  return {
    source: "新浪资金流实时全市场",
    status: "已取得",
    date: todayChina().slice(0, 10).replace(/\//g, "-"),
    mainNetInflowYi: yi(row.r0_net),
    mainNetInflowPct: row.r0_ratio === null || row.r0_ratio === undefined ? null : round(Number(row.r0_ratio) * 100),
    netInflowYi: yi(row.netamount),
    netInflowPct: row.ratioamount === null || row.ratioamount === undefined ? null : round(Number(row.ratioamount) * 100),
    largeOrderInflowYi: yi(row.r0_in),
    largeOrderOutflowYi: yi(row.r0_out),
    reason: previousError ? `东方财富资金流不可用，使用新浪资金流口径补充；东方财富错误：${previousError}` : "使用新浪资金流口径"
  };
}

function avg(rows, field) {
  const values = rows.map(r => Number(r[field])).filter(Number.isFinite);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function latest(rows) {
  return rows && rows.length ? rows[0] : null;
}

function analyzeFinancial(incomeRows, balanceRows, cashRows) {
  const income = latest(incomeRows);
  const balance = latest(balanceRows);
  const cash = latest(cashRows);
  if (!income && !balance && !cash) {
    return {
      status: "财报缺失",
      score: -8,
      supports: [],
      risks: ["未取得东方财富三表数据，本项不能加分"],
      reportDate: "",
      source: "东方财富财务报表"
    };
  }

  const supports = [];
  const risks = [];
  if (income?.PARENT_NETPROFIT_RATIO > 0) supports.push(`归母净利润同比增长 ${round(income.PARENT_NETPROFIT_RATIO)}%`);
  if (income?.PARENT_NETPROFIT_RATIO < 0) risks.push(`归母净利润同比下降 ${round(Math.abs(income.PARENT_NETPROFIT_RATIO))}%`);
  if (income?.TOI_RATIO > 0) supports.push(`营业收入同比增长 ${round(income.TOI_RATIO)}%`);
  if (income?.TOI_RATIO < 0) risks.push(`营业收入同比下降 ${round(Math.abs(income.TOI_RATIO))}%`);
  if (cash?.NETCASH_OPERATE > 0) supports.push(`经营现金流为正 ${yi(cash.NETCASH_OPERATE)} 亿元`);
  if (cash?.NETCASH_OPERATE < 0) risks.push(`经营现金流为负 ${yi(cash.NETCASH_OPERATE)} 亿元`);
  if (balance?.DEBT_ASSET_RATIO !== null && balance?.DEBT_ASSET_RATIO < 55) supports.push(`资产负债率 ${round(balance.DEBT_ASSET_RATIO)}%，财务压力可控`);
  if (balance?.DEBT_ASSET_RATIO > 70) risks.push(`资产负债率 ${round(balance.DEBT_ASSET_RATIO)}%，财务压力偏高`);

  const grossMargin = income?.TOTAL_OPERATE_INCOME && income?.OPERATE_COST !== null
    ? (income.TOTAL_OPERATE_INCOME - income.OPERATE_COST) / income.TOTAL_OPERATE_INCOME * 100
    : null;
  if (grossMargin !== null && grossMargin > 25) supports.push(`毛利率约 ${round(grossMargin)}%`);
  if (grossMargin !== null && grossMargin < 10) risks.push(`毛利率约 ${round(grossMargin)}%，盈利弹性偏弱`);

  const score = supports.length * 4 - risks.length * 5;
  return {
    status: risks.length > supports.length ? "基本面减分" : supports.length >= 3 ? "基本面支撑" : "基本面待验证",
    score,
    supports,
    risks,
    reportDate: String(income?.REPORT_DATE || balance?.REPORT_DATE || cash?.REPORT_DATE || "").slice(0, 10),
    revenueYi: yi(income?.TOTAL_OPERATE_INCOME),
    revenueYoY: pct(income?.TOI_RATIO),
    netProfitYi: yi(income?.PARENT_NETPROFIT),
    netProfitYoY: pct(income?.PARENT_NETPROFIT_RATIO),
    operatingCashflowYi: yi(cash?.NETCASH_OPERATE),
    debtAssetRatio: pct(balance?.DEBT_ASSET_RATIO),
    grossMargin: pct(grossMargin),
    source: "东方财富财务报表"
  };
}

function analyzeAnnouncements(anns) {
  const riskWords = ["减持", "问询", "处罚", "冻结", "诉讼", "亏损", "终止", "退市", "立案", "监管"];
  const goodWords = ["中标", "回购", "增持", "业绩预增", "重大合同", "投资者关系", "扩产"];
  const risks = anns.filter(a => riskWords.some(w => a.title.includes(w)));
  const positives = anns.filter(a => goodWords.some(w => a.title.includes(w)));
  const sources = [...new Set(anns.map(a => a.source).filter(Boolean))];
  return {
    status: risks.length ? "公告风险待核查" : positives.length ? "公告偏正面" : anns.length ? "常规公告" : "公告缺失",
    score: positives.length * 3 - risks.length * 8,
    latest: anns,
    positives: positives.map(a => `${a.date} ${a.title}`),
    risks: risks.map(a => `${a.date} ${a.title}`),
    source: sources.length ? sources.join("、") : "东方财富公告/巨潮资讯公告"
  };
}

function analyzeTechnical(daily, m30, m5) {
  if (!daily.length) {
    return {
      status: "K线缺失",
      score: -12,
      supports: [],
      risks: ["未取得复权日K，不能生成交易计划"],
      trendStage: { stage: "数据缺失", description: "未取得日K，无法判断趋势阶段", score: -10 },
      momentum: { r20: null, r60: null, r120: null, rpsProxy: null, note: "K线缺失" },
      chan: { buyType: "无买点", action: "等待数据", entryZone: "暂无", stop: null, add: null, takeProfit: null, invalidation: ["K线数据缺失"] }
    };
  }

  const last = daily[daily.length - 1];
  const d20 = daily.slice(-20);
  const d60 = daily.slice(-60);
  const ma5 = avg(daily.slice(-5), "close");
  const ma20 = avg(d20, "close");
  const ma60 = avg(d60, "close");
  const high20 = Math.max(...d20.map(k => k.high));
  const low20 = Math.min(...d20.map(k => k.low));
  const mid20 = (high20 + low20) / 2;
  const supports = [];
  const risks = [];

  if (ma5 && ma20 && ma5 > ma20) supports.push("日线 MA5 高于 MA20，短线趋势偏强");
  if (ma20 && ma60 && ma20 > ma60) supports.push("日线 MA20 高于 MA60，中期结构偏强");
  if (last.close >= high20 * 0.96) supports.push("收盘接近 20 日高位，趋势保持强势");
  if (last.close < ma20) risks.push("收盘低于 MA20，买点需要降级");
  if (last.turnover && last.turnover > 15) risks.push("换手率偏高，短线波动风险较大");

  const m30State = analyzeMinute(m30, "30分钟");
  const m5State = analyzeMinute(m5, "5分钟");
  const chan = buildChan({ last, ma5, ma20, ma60, high20, low20, mid20, m30State, m5State });
  const trendStage = classifyTrendStage({ last, ma20, ma60, high20, low20, mid20 });
  const momentum = calculateMomentum(daily);

  const score = supports.length * 5 + trendStage.score + (momentum.rpsProxy || 0) / 12 + (m30State.confirmed ? 8 : -2) + (m5State.confirmed ? 5 : 0) - risks.length * 5;
  return {
    status: supports.length >= 2 && !risks.length ? "趋势偏强" : risks.length ? "技术待确认" : "震荡观察",
    score: round(score, 1),
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
    trendStage,
    momentum,
    m30: m30State,
    m5: m5State,
    chan,
    source: "东方财富复权日K、30分钟K、5分钟K"
  };
}

function classifyTrendStage({ last, ma20, ma60, high20, low20, mid20 }) {
  const close = last.close;
  const nearHigh = close >= high20 * 0.92;
  const nearLow = close <= low20 * 1.08;
  if (ma20 && ma60 && close > ma20 && ma20 > ma60 && nearHigh) {
    return { stage: "阶段2：上升趋势", description: "价格位于 MA20/MA60 上方，且接近 20 日高位，优先寻找回踩买点", score: 10 };
  }
  if (ma20 && ma60 && close > ma60 && close >= mid20) {
    return { stage: "阶段3：高位震荡", description: "仍在中枢上半区，但趋势延续需要低级别确认和放量", score: 2 };
  }
  if (ma20 && ma60 && close < ma20 && ma20 < ma60) {
    return { stage: "阶段4：下降趋势", description: "价格低于 MA20 且 MA20 低于 MA60，原则上不建新仓", score: -14 };
  }
  if (nearLow || close < mid20) {
    return { stage: "阶段1：筑底观察", description: "接近区间低位或仍在中枢下半区，只观察底分型和低级别转强", score: -4 };
  }
  return { stage: "震荡过渡", description: "趋势阶段不够清晰，等待方向选择", score: -1 };
}

function calculateMomentum(daily) {
  const last = daily[daily.length - 1];
  const changeFrom = days => {
    if (daily.length <= days) return null;
    const base = daily[daily.length - 1 - days]?.close;
    if (!base) return null;
    return round((last.close / base - 1) * 100, 2);
  };
  const r20 = changeFrom(20);
  const r60 = changeFrom(60);
  const r120 = changeFrom(120);
  const weighted = [r20, r60, r120].filter(v => v !== null);
  const avgReturn = weighted.length ? weighted.reduce((sum, value) => sum + value, 0) / weighted.length : null;
  const rpsProxy = avgReturn === null ? null : Math.max(0, Math.min(100, round(50 + avgReturn * 1.6, 1)));
  return {
    r20,
    r60,
    r120,
    rpsProxy,
    note: "基于个股20/60/120日涨跌幅计算的动量代理；候选池相对排名在全部候选 enrich 完成后生成"
  };
}

function analyzeMinute(rows, label) {
  if (!rows.length) {
    return { label, confirmed: false, status: `${label}缺失`, supports: [], risks: [`未取得${label}K线`] };
  }
  const recent = rows.slice(-48);
  const last = recent[recent.length - 1];
  const high = Math.max(...recent.map(r => r.high));
  const low = Math.min(...recent.map(r => r.low));
  const mid = (high + low) / 2;
  const ma12 = avg(recent.slice(-12), "close");
  const ma48 = avg(recent, "close");
  const supports = [];
  const risks = [];
  if (last.close > ma12 && ma12 > ma48) supports.push(`${label}短均线向上`);
  if (last.close > mid) supports.push(`${label}收盘在近 48 根中位上方`);
  if (last.close < ma48) risks.push(`${label}收盘低于近 48 根均价`);
  if (last.close < mid) risks.push(`${label}仍在中位下方`);
  return {
    label,
    confirmed: supports.length >= 2,
    status: supports.length >= 2 ? `${label}确认偏强` : risks.length ? `${label}待确认` : `${label}震荡`,
    lastDate: last.date,
    high: round(high),
    low: round(low),
    mid: round(mid),
    ma12: round(ma12),
    ma48: round(ma48),
    supports,
    risks
  };
}

function buildChan({ last, ma5, ma20, high20, low20, mid20, m30State, m5State }) {
  const close = last.close;
  const nearHigh = close >= high20 * 0.97;
  const aboveCenter = close >= mid20;
  const belowMa20 = ma20 && close < ma20;
  const range = high20 - low20;
  let stop = round(Math.min(low20, ma20 || low20) * 0.97);
  const add = round(Math.max(ma5 || 0, ma20 || 0, mid20));
  const takeProfit = round(Math.max(high20 * 1.08, close * 1.08));

  let buyType = "无明确买点";
  let action = "观察，不建仓";
  const conditions = [];
  const invalidation = [];
  let firstPosition = "0";

  if (belowMa20) {
    buyType = "无买点/风险段";
    action = "不建新仓，等待重新站回 MA20 且低级别结构转强";
    stop = round(low20 * 0.97);
    conditions.push(`重新站回 MA20 ${round(ma20)}，且 30分钟/5分钟重新转强`);
    invalidation.push(`有效跌破 20 日低点 ${round(low20)}，技术面继续减分`);
  } else if (nearHigh && m30State.confirmed) {
    buyType = "类三买观察";
    action = "不追高，等待突破后回踩不破再试仓";
    firstPosition = m5State.confirmed ? "10%-20%试仓" : "0%-10%观察仓";
    stop = round(Math.max(mid20 * 0.98, add * 0.94));
    conditions.push(`放量突破或站稳 20 日高点 ${round(high20)} 后，回踩不破 ${add}`);
    conditions.push(m5State.confirmed ? "5分钟结构已确认，可小仓试错" : "等待 5分钟确认后再动手");
    invalidation.push(`跌回 20 日中位 ${round(mid20)} 下方，类三买观察失效`);
  } else if (aboveCenter && m30State.confirmed) {
    buyType = "类二买/趋势延续观察";
    action = "等待回踩 MA20 或中枢上沿附近企稳，轻仓试错";
    firstPosition = m5State.confirmed ? "10%-20%试仓" : "0%-10%观察仓";
    stop = round(Math.max(low20 * 0.97, (ma20 || mid20) * 0.96));
    conditions.push(`回踩不破 MA20 ${round(ma20)} 或 20 日中位 ${round(mid20)}`);
    conditions.push("缩量回踩后重新放量向上，才考虑加仓");
    invalidation.push(`跌破 MA20 且 30分钟转弱，取消买点`);
  } else if (aboveCenter) {
    buyType = "中枢上半区观察";
    action = "位置不差但低级别未确认，等待 30分钟转强";
    conditions.push(`30分钟重新站回中位，并形成更高低点`);
    invalidation.push(`跌破 20 日中位 ${round(mid20)}，降级为震荡`);
  } else {
    buyType = "潜在一买观察";
    action = "只观察，不提前抄底；等待底分型与低级别转强";
    conditions.push(`接近 20 日低点 ${round(low20)} 后不再创新低`);
    conditions.push("5分钟/30分钟出现转强并重新站回中位");
    invalidation.push(`跌破 20 日低点 ${round(low20)}，一买观察失败`);
  }

  return {
    buyType,
    action,
    entryZone: buyType.startsWith("无买点") ? "暂无" : `${round(Math.max(low20, mid20 - range * 0.18))}-${round(Math.min(high20, mid20 + range * 0.28))}`,
    firstPosition,
    add: add || null,
    stop,
    takeProfit,
    conditions,
    invalidation,
    caveat: "当前为实用版缠论近似判断：已使用日K、30分钟K、5分钟K做多周期确认；严格笔、线段、中枢、背驰自动识别后续再增强。"
  };
}

function focusReason(stock, profile) {
  const text = [stock.name, ...(stock.boards || []).map(b => b.name), profile?.industryPath, ...(profile?.concepts || [])].join(" ");
  const boardSectorEntries = Object.entries(stock.sectorScores || {}).sort((a, b) => b[1] - a[1]);
  const boardSector = boardSectorEntries[0]?.[0];
  const cls = classifySectorText(text);
  const area = boardSector || cls.sector || "其它";
  const sector = SECTOR_CONFIG.find(s => s.name === area);
  const hits = [...new Set([...(cls.hits || []), ...(stock.boards || []).filter(b => b.sector === area).map(b => b.name)])].slice(0, 8);
  return {
    area,
    sectorPriority: sector?.priority || cls.priority || 0,
    sectorQuota: sector?.candidateQuota || 1,
    hits,
    text: hits.length ? `归属板块：${area}；命中：${hits.slice(0, 5).join("、")}` : `归属板块：${area}`
  };
}

function baseScore(stock) {
  let score = 0;
  const supports = [];
  const risks = [];
  if ((stock.amountYi || 0) >= 10) { score += 14; supports.push(`成交额 ${stock.amountYi} 亿元，流动性较好`); }
  else if ((stock.amountYi || 0) >= 3) { score += 8; supports.push(`成交额 ${stock.amountYi} 亿元，具备跟踪流动性`); }
  else risks.push("成交额偏低，实盘滑点和波动风险更高");
  if ((stock.pct || 0) >= 3) { score += 8; supports.push(`当日涨幅 ${stock.pct}%，短线强于市场`); }
  if ((stock.pct || 0) <= -4) { score -= 6; risks.push(`当日跌幅 ${stock.pct}%，需确认是否有利空或破位`); }
  if ((stock.volumeRatio || 0) >= 1.5) { score += 5; supports.push(`量比 ${stock.volumeRatio}，资金关注度提升`); }
  if ((stock.turnover || 0) > 15) { score -= 5; risks.push(`换手率 ${stock.turnover}%，短线分歧偏大`); }
  if (stock.pe && stock.pe > 0 && stock.pe < 80) { score += 4; supports.push(`PE ${stock.pe}，估值未进入极端异常区`); }
  if (stock.pe && stock.pe > 120) { score -= 4; risks.push(`PE ${stock.pe}，估值风险偏高`); }
  if ((stock.mainNetInflowYi || 0) > 0) { score += 4; supports.push(`主力净流入 ${stock.mainNetInflowYi} 亿元`); }
  if ((stock.mainNetInflowYi || 0) < -1) { score -= 4; risks.push(`主力净流出 ${Math.abs(stock.mainNetInflowYi)} 亿元`); }
  return { score, supports, risks };
}

function buildTradePlan(stock, focus, financial, announcements, technical) {
  const support = [];
  const risk = [];
  const base = baseScore(stock);
  const riskReward = calculateRiskReward(stock.price, technical.chan);
  const votes = buildStrategyVotes(stock, focus, financial, announcements, technical, riskReward);
  support.push(...base.supports, focus.text, technical.trendStage?.description, ...financial.supports.slice(0, 3), ...technical.supports.slice(0, 3), ...announcements.positives.slice(0, 2), ...votes.passed.map(v => `策略通过：${v}`));
  risk.push(...base.risks, ...financial.risks.slice(0, 3), ...technical.risks.slice(0, 3), ...announcements.risks.slice(0, 2), ...(technical.chan?.invalidation || []), ...votes.failed.map(v => `策略否决：${v}`));

  const blocked = financial.status === "基本面减分" || announcements.status === "公告风险待核查" || technical.chan.buyType.startsWith("无买点") || technical.trendStage?.stage?.startsWith("阶段4") || (riskReward.ratio !== null && riskReward.ratio < 1.2);
  const structurePenalty = technical.chan.buyType.startsWith("无买点") ? -22 : technical.chan.buyType === "中枢上半区观察" ? -8 : 0;
  const riskPenalty = announcements.status === "公告风险待核查" ? -12 : financial.status === "基本面减分" ? -10 : 0;
  const boardBonus = Math.min(6, (stock.boards?.length || 0) * 1.2);
  const sectorBonus = focus.area === "科技" ? 8 : focus.area === "新能源/电力设备" ? 4 : 0;
  const relativeBonus = technical.relativeStrength?.score ? Math.min(8, technical.relativeStrength.score / 12) : 0;
  const voteBonus = votes.passCount * 2 - votes.failCount * 5;
  const rrPenalty = riskReward.ratio !== null && riskReward.ratio < 1.8 ? -10 : riskReward.ratio >= 2.5 ? 5 : 0;
  const rawScore = 38 + base.score + financial.score + announcements.score + technical.score + boardBonus + sectorBonus + structurePenalty + riskPenalty + relativeBonus + voteBonus + rrPenalty;
  const score = Math.max(0, Math.min(96, rawScore));
  let state = "观察池";
  if (blocked) state = "暂不交易";
  else if (score >= 72 && technical.m30?.confirmed && technical.m5?.confirmed) state = "交易准备池";
  else if (score >= 62 && technical.m30?.confirmed) state = "重点跟踪池";
  else if (score >= 52) state = "观察池";
  else state = "低优先级";

  const nextAction = state === "交易准备池"
    ? "只在回踩不破触发条件时试仓；高开急拉不追。"
    : state === "重点跟踪池"
      ? "加入盘中观察，等待 5分钟确认或回踩关键位。"
      : state === "暂不交易"
        ? "当前不建仓，等风险解除或结构修复。"
        : "保留观察，等待评分或买点改善。";

  return {
    state,
    score: round(score, 1),
    focusArea: focus.area,
    trendStage: technical.trendStage,
    relativeStrength: technical.relativeStrength || null,
    strategyVotes: votes,
    riskReward,
    buyType: technical.chan.buyType,
    action: technical.chan.action,
    nextAction,
    entryZone: technical.chan.entryZone,
    firstPosition: technical.chan.firstPosition,
    addCondition: technical.chan.add ? `站稳或回踩不破 ${technical.chan.add} 后，且 30分钟/5分钟继续偏强` : "暂无",
    stop: technical.chan.stop,
    takeProfit: technical.chan.takeProfit,
    trackingPeriod: state === "交易准备池" || state === "重点跟踪池" ? "推荐后先按 3-15 个交易日跟踪，未触发条件不执行" : "暂不进入交易跟踪",
    conditions: technical.chan.conditions,
    trigger: buildNextTrigger(stock, technical, riskReward, state),
    support: support.slice(0, 10),
    risk: risk.slice(0, 10),
    caveat: technical.chan.caveat
  };
}

function calculateRiskReward(price, chan) {
  const stop = Number(chan?.stop);
  const target = Number(chan?.takeProfit);
  const entry = plannedEntryPrice(price, chan?.entryZone);
  if (!entry || !stop || !target || stop >= entry || target <= entry) {
    return { ratio: null, maxLossPct: null, targetGainPct: null, text: "风险收益比无法计算" };
  }
  const maxLossPct = round(((entry - stop) / entry) * 100, 2);
  const targetGainPct = round((target / entry - 1) * 100, 2);
  const ratio = maxLossPct > 0 ? round(targetGainPct / maxLossPct, 2) : null;
  return {
    entry: round(entry),
    ratio,
    maxLossPct,
    targetGainPct,
    text: ratio === null ? "风险收益比无法计算" : `按计划价 ${round(entry)} 计算，约 1:${ratio}，最大亏损约 ${maxLossPct}%，目标空间约 ${targetGainPct}%`
  };
}

function plannedEntryPrice(price, entryZone) {
  const parts = String(entryZone || "").match(/[\d.]+/g)?.map(Number).filter(Number.isFinite) || [];
  if (parts.length >= 2) return Math.min(price, Math.max(...parts));
  if (parts.length === 1) return Math.min(price, parts[0]);
  return price;
}

function buildStrategyVotes(stock, focus, financial, announcements, technical, riskReward) {
  const items = [
    ["趋势阶段", technical.trendStage?.stage?.startsWith("阶段2") || technical.trendStage?.stage === "阶段3：高位震荡", technical.trendStage?.stage || "趋势未知"],
    ["缠论买点", !technical.chan?.buyType?.startsWith("无买点"), technical.chan?.buyType || "无买点"],
    ["相对强度", (technical.relativeStrength?.score || technical.momentum?.rpsProxy || 0) >= 60, `强度 ${technical.relativeStrength?.score ?? technical.momentum?.rpsProxy ?? "缺失"}`],
    ["资金流", stock.mainNetInflowYi === null || stock.mainNetInflowYi === undefined ? null : stock.mainNetInflowYi > 0, stock.mainNetInflowYi == null ? "资金流缺失" : `主力净流入 ${stock.mainNetInflowYi} 亿`],
    ["财务质量", financial.status !== "基本面减分", financial.status],
    ["公告事件", announcements.status !== "公告风险待核查", announcements.status],
    ["风险收益比", riskReward.ratio === null ? null : riskReward.ratio >= 1.8, riskReward.text],
    ["板块权重", focus.area === "科技" || focus.sectorPriority >= 50, focus.area]
  ];
  const passed = [];
  const failed = [];
  const neutral = [];
  for (const [name, ok, detail] of items) {
    const text = `${name}：${detail}`;
    if (ok === true) passed.push(text);
    else if (ok === false) failed.push(text);
    else neutral.push(text);
  }
  return { passed, failed, neutral, passCount: passed.length, failCount: failed.length, neutralCount: neutral.length };
}

function buildNextTrigger(stock, technical, riskReward, state) {
  const add = technical.chan?.add;
  const stop = technical.chan?.stop;
  const high20 = technical.high20;
  const m5 = technical.m5?.status || "5分钟未确认";
  if (state === "暂不交易") {
    return `暂不操作；只有重新站回关键位 ${add || technical.ma20 || "MA20"} 且 ${m5.replace("待确认", "转强")}，才重新评估。`;
  }
  if (technical.chan?.buyType === "类三买观察") {
    return `等待突破或站稳 ${high20} 后回踩不破 ${add}；若跌破 ${stop} 或风险收益比低于 1:1.8，取消交易计划。`;
  }
  if (technical.chan?.buyType?.includes("类二买")) {
    return `等待回踩 ${technical.ma20 || technical.mid20} 附近缩量企稳，并在 30分钟/5分钟转强后试仓；跌破 ${stop} 取消。`;
  }
  return `等待 30分钟和5分钟同时转强，再按 ${technical.chan?.entryZone || "计划区间"} 评估；当前不追高。`;
}

async function enrichStock(stock) {
  const [daily, m30, m5, income, balance, cash, anns, profile] = await Promise.all([
    guarded(`K线（日） ${stock.code}`, () => fetchKlineWithFallback(stock.code, 101, 180), []),
    guarded(`K线（30分钟） ${stock.code}`, () => fetchKlineWithFallback(stock.code, 30, 160), []),
    guarded(`K线（5分钟） ${stock.code}`, () => fetchKlineWithFallback(stock.code, 5, 160), []),
    guarded(`利润表 ${stock.code}`, () => fetchReport(stock.code, "RPT_DMSK_FN_INCOME"), []),
    guarded(`资产负债表 ${stock.code}`, () => fetchReport(stock.code, "RPT_DMSK_FN_BALANCE"), []),
    guarded(`现金流量表 ${stock.code}`, () => fetchReport(stock.code, "RPT_DMSK_FN_CASHFLOW"), []),
    guarded(`公告 ${stock.code}`, () => fetchAnnouncementsWithFallback(stock.code), []),
    guarded(`F10 ${stock.code}`, () => fetchCompanyProfile(stock.code), {})
  ]);
  const focus = focusReason(stock, profile);
  const financial = analyzeFinancial(income, balance, cash);
  const announcements = analyzeAnnouncements(anns);
  const technical = analyzeTechnical(daily, m30, m5);
  const tradePlan = buildTradePlan(stock, focus, financial, announcements, technical);
  return {
    ...stock,
    boards: (stock.boards || []).slice(0, 6),
    focus,
    profile,
    capitalFlow: { source: "东方财富资金流", status: "待补充", mainNetInflowYi: null },
    financial,
    announcements,
    technical,
    tradePlan
  };
}

async function enrichCandidates(stocks, forceCodes = new Set()) {
  const ranked = stocks
    .filter(s => s.price && s.amountYi !== null)
    .map(s => {
      const cls = classifySectorText([s.name, ...(s.boards || []).map(b => b.name)].join(" "));
      const sector = Object.entries(s.sectorScores || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || cls.sector;
      const sectorCfg = SECTOR_CONFIG.find(x => x.name === sector);
      return { ...s, sectorGroup: sector || "其它", sectorPriority: sectorCfg?.priority || cls.priority || 0, quick: baseScore(s) };
    })
    .filter(s => /^[036]/.test(String(s.code || "")))
    .filter(s => !EXCLUDE_STOCK_TEXT_KEYWORDS.some(k => [s.name, ...(s.boards || []).map(b => b.name)].join(" ").includes(k)))
    .filter(s => (s.amountYi || 0) >= 0.05)
    .sort((a, b) => ((b.quick.score + (b.boards?.length || 0) * 3 + (b.sectorPriority || 0) / 20) - (a.quick.score + (a.boards?.length || 0) * 3 + (a.sectorPriority || 0) / 20)));

  const picked = [];
  const used = new Set();
  const pickFrom = (sectorName, quota, maxTotal = 52) => {
    for (const row of ranked.filter(s => s.sectorGroup === sectorName)) {
      if (picked.length >= maxTotal) break;
      if (used.has(row.code)) continue;
      picked.push(row);
      used.add(row.code);
      if (picked.filter(x => x.sectorGroup === sectorName).length >= quota) break;
    }
  };
  pickFrom("科技", 16, 16);
  for (const sector of SECTOR_CONFIG.filter(s => s.name !== "科技")) {
    pickFrom(sector.name, sector.candidateQuota, 52);
  }
  for (const row of ranked.filter(s => forceCodes.has(s.code))) {
    if (used.has(row.code)) continue;
    picked.push(row);
    used.add(row.code);
  }
  const enriched = [];
  const concurrency = 2;
  for (let i = 0; i < picked.length; i += concurrency) {
    const batch = picked.slice(i, i + concurrency);
    enriched.push(...await Promise.all(batch.map(enrichStock)));
  }

  if (enriched.length) {
    for (const candidate of enriched) {
      try {
        const flow = await fetchCapitalFlow(candidate.code);
        candidate.capitalFlow = flow;
        candidate.mainNetInflowYi = flow.mainNetInflowYi ?? candidate.mainNetInflowYi ?? null;
      } catch (error) {
        candidate.capitalFlow = {
          source: "东方财富资金流",
          status: "资金流缺失",
          mainNetInflowYi: null,
          reason: cleanError(error)
        };
        audit.failures.push({ name: `东方财富资金流 ${candidate.code}`, error: cleanError(error) });
      }
      await new Promise(resolve => setTimeout(resolve, 180));
    }
  }

  applyRelativeStrength(enriched);
  for (const candidate of enriched) {
    candidate.tradePlan = buildTradePlan(candidate, candidate.focus, candidate.financial, candidate.announcements, candidate.technical);
  }

  const rank = { "交易准备池": 5, "重点跟踪池": 4, "观察池": 3, "低优先级": 2, "暂不交易": 1 };
  return enriched
    .sort((a, b) => {
      const sectorDelta = (b.focus?.sectorPriority || 0) - (a.focus?.sectorPriority || 0);
      const stateDelta = (rank[b.tradePlan.state] || 0) - (rank[a.tradePlan.state] || 0);
      return sectorDelta || stateDelta || b.tradePlan.score - a.tradePlan.score;
    });
}

function findTrackingRecord(previousSnapshot, code) {
  const records = previousSnapshot?.recommendationTracking?.records || [];
  if (Array.isArray(records)) return records.find(record => record.code === code) || null;
  return records[code] || null;
}

function isConfirmedRemoved(removalState, code) {
  return Boolean(removalState?.confirmedRemoved?.[code]);
}

function buildStabilityForceCodes(previousSnapshot, removalState) {
  const previousCandidates = previousSnapshot?.candidates || [];
  const protectedRows = [];
  for (const candidate of previousCandidates) {
    if (!candidate?.code || isConfirmedRemoved(removalState, candidate.code)) continue;
    const state = candidate.tradePlan?.state || "";
    const score = Number(candidate.tradePlan?.score || 0);
    const record = findTrackingRecord(previousSnapshot, candidate.code);
    const seenCount = Array.isArray(record?.recommendations) ? record.recommendations.length : 1;
    const shouldProtect =
      state === "交易准备池" ||
      state === "重点跟踪池" ||
      (state === "观察池" && score >= 58) ||
      Boolean(removalState?.keepTracking?.[candidate.code]);
    if (!shouldProtect) continue;
    protectedRows.push({ code: candidate.code, score, state, seenCount });
  }
  protectedRows.sort((a, b) => {
    const stateRank = { "交易准备池": 5, "重点跟踪池": 4, "观察池": 3 };
    return (stateRank[b.state] || 0) - (stateRank[a.state] || 0) || b.seenCount - a.seenCount || b.score - a.score;
  });
  return new Set(protectedRows.slice(0, 36).map(row => row.code));
}

function assignStabilityLayers(candidates, previousSnapshot, removalState) {
  const previousMap = new Map((previousSnapshot?.candidates || []).map(candidate => [candidate.code, candidate]));
  const layerRank = { "核心跟踪池": 6, "今日机会池": 5, "候选观察池": 4, "待确认剔除": 2, "暂不交易": 1 };
  const currentDate = dateOnly(todayChina());
  const summary = {
    policy: {
      name: "稳定推荐策略 v0.2",
      principle: "推荐池按中期跟踪管理，日内扫描只负责发现新机会，不因单日分数波动频繁换股。",
      coreRule: "上次已在交易准备池、重点跟踪池或高分观察池的股票，本次刷新会优先保留并重新分析。",
      opportunityRule: "新进入且满足买点/评分条件的股票标记为今日机会池，先观察触发条件，不直接替代核心跟踪。",
      removalRule: "只有出现趋势破坏、跌破止损、风险收益比失效、财报公告硬风险或连续弱于预期，才进入待确认剔除；未经确认不停止追踪。"
    },
    counts: {},
    protectedCodes: [],
    newOpportunityCodes: [],
    downgradeReviewCodes: []
  };

  for (const candidate of candidates) {
    const previous = previousMap.get(candidate.code);
    const state = candidate.tradePlan?.state || "";
    const score = Number(candidate.tradePlan?.score || 0);
    const previousState = previous?.tradePlan?.state || "";
    const previousScore = Number(previous?.tradePlan?.score || 0);
    const previousLayer = previous?.stability?.layer || previous?.tradePlan?.trackingLayer || "";
    const record = findTrackingRecord(previousSnapshot, candidate.code);
    const seenCount = Array.isArray(record?.recommendations) ? record.recommendations.length : (previous ? 1 : 0);
    const firstTrackingDate = dateOnly(record?.firstRecommendedAtChina || previousSnapshot?.generatedAtChina || "");
    const sameDayNewOpportunity = firstTrackingDate === currentDate && (previousLayer === "今日机会池" || seenCount <= 2);
    const rr = candidate.tradePlan?.riskReward?.ratio;
    const wasMeaningfulRecommendation =
      Boolean(removalState?.keepTracking?.[candidate.code]) ||
      previousLayer === "核心跟踪池" ||
      previousLayer === "今日机会池" ||
      previousState === "交易准备池" ||
      previousState === "重点跟踪池" ||
      (previousState === "观察池" && previousScore >= 58);
    const hasHardRisk =
      state === "暂不交易" ||
      state === "低优先级" ||
      String(candidate.technical?.trendStage?.stage || "").startsWith("阶段4") ||
      (rr !== null && rr !== undefined && Number(rr) < 1.2);

    let layer = "候选观察池";
    let reason = "进入候选池但尚未形成稳定交易机会，继续等待评分、趋势或买点改善。";
    if (previous && wasMeaningfulRecommendation && hasHardRisk) {
      layer = "待确认剔除";
      reason = "原候选本次出现硬风险或交易条件失效，先保留在追踪中，需人工确认后才停止跟踪。";
      summary.downgradeReviewCodes.push(candidate.code);
    } else if (previous && sameDayNewOpportunity && (state === "交易准备池" || state === "重点跟踪池") && score >= 70) {
      layer = "今日机会池";
      reason = "同一交易日内仍按新增机会处理；至少跨交易日继续满足条件后再升级为核心跟踪。";
      summary.newOpportunityCodes.push(candidate.code);
    } else if (previous && wasMeaningfulRecommendation && (state === "交易准备池" || state === "重点跟踪池" || score >= 58)) {
      layer = "核心跟踪池";
      reason = `已连续跟踪 ${Math.max(1, seenCount)} 次，本次继续满足中期跟踪条件；不因单日排序波动移出。`;
      summary.protectedCodes.push(candidate.code);
    } else if (!previous && (state === "交易准备池" || state === "重点跟踪池") && score >= 70) {
      layer = "今日机会池";
      reason = "新入池且买点/评分较强，作为新增机会观察，需等触发条件确认后再执行。";
      summary.newOpportunityCodes.push(candidate.code);
    } else if (state === "暂不交易" || state === "低优先级") {
      layer = "暂不交易";
      reason = "当前风险收益比、趋势阶段或基本面/公告条件不支持交易。";
    }

    candidate.stability = {
      layer,
      reason,
      previousState: previous?.tradePlan?.state || "",
      previousScore: previous?.tradePlan?.score ?? null,
      trackingRefreshes: seenCount,
      firstRecommendedAtChina: record?.firstRecommendedAtChina || previousSnapshot?.generatedAtChina || ""
    };
    if (candidate.tradePlan) {
      candidate.tradePlan.trackingLayer = layer;
      candidate.tradePlan.trackingPeriod = layer === "核心跟踪池"
        ? "默认按 2-8 周跟踪，中途只根据止损、趋势破坏、重大风险或人工确认剔除。"
        : layer === "今日机会池"
          ? "新增机会先跟踪 3-5 个交易日，只有触发买点才进入交易计划。"
          : layer === "待确认剔除"
            ? "继续保留但暂停新开仓，等待人工确认是否踢出推荐追踪。"
            : candidate.tradePlan.trackingPeriod;
    }
    summary.counts[layer] = (summary.counts[layer] || 0) + 1;
  }

  candidates.sort((a, b) => {
    const layerDelta = (layerRank[b.stability?.layer] || 0) - (layerRank[a.stability?.layer] || 0);
    const sectorDelta = (b.focus?.sectorPriority || 0) - (a.focus?.sectorPriority || 0);
    const scoreDelta = Number(b.tradePlan?.score || 0) - Number(a.tradePlan?.score || 0);
    return layerDelta || sectorDelta || scoreDelta;
  });
  return summary;
}

function buildStableActionList(candidates) {
  const used = new Set();
  const take = (rows, level, mapper, limit) => rows
    .filter(candidate => {
      if (used.has(candidate.code)) return false;
      used.add(candidate.code);
      return true;
    })
    .slice(0, limit)
    .map(candidate => ({
      level,
      code: candidate.code,
      name: candidate.name,
      text: mapper(candidate),
      price: candidate.price,
      score: candidate.tradePlan.score,
      stabilityLayer: candidate.stability?.layer || candidate.tradePlan?.trackingLayer || ""
    }));
  return [
    ...take(candidates.filter(c => c.stability?.layer === "核心跟踪池"), "核心跟踪", c => `${c.name}：继续按原计划跟踪，${c.tradePlan.nextAction}；${c.stability?.reason || ""}`, 6),
    ...take(candidates.filter(c => c.stability?.layer === "今日机会池"), "今日机会", c => `${c.name}：${c.tradePlan.buyType}，${c.tradePlan.nextAction}`, 6),
    ...take(candidates.filter(c => c.stability?.layer === "待确认剔除"), "待确认剔除", c => `${c.name}：${c.stability?.reason || c.tradePlan.risk?.[0] || "交易条件失效"}`, 6),
    ...take(candidates.filter(c => c.tradePlan.state === "交易准备池"), "可准备", c => `${c.name}：${c.tradePlan.buyType}，${c.tradePlan.nextAction}`, 4),
    ...take(candidates.filter(c => c.tradePlan.state === "重点跟踪池"), "跟踪", c => `${c.name}：等待触发条件，建仓区间 ${c.tradePlan.entryZone}`, 4),
    ...take(candidates.filter(c => c.tradePlan.state === "暂不交易"), "回避", c => `${c.name}：${c.tradePlan.risk[0] || "当前风险收益比不合适"}`, 4)
  ];
}

function applyRelativeStrength(candidates) {
  const metrics = [
    ["r20", "20日"],
    ["r60", "60日"],
    ["r120", "120日"]
  ];
  for (const [key] of metrics) {
    const sorted = candidates
      .filter(candidate => candidate.technical?.momentum?.[key] !== null && candidate.technical?.momentum?.[key] !== undefined)
      .sort((a, b) => a.technical.momentum[key] - b.technical.momentum[key]);
    sorted.forEach((candidate, index) => {
      if (!candidate.technical.relativeStrength) candidate.technical.relativeStrength = {};
      candidate.technical.relativeStrength[key] = sorted.length <= 1 ? 100 : round((index / (sorted.length - 1)) * 100, 1);
    });
  }
  for (const candidate of candidates) {
    const rs = candidate.technical?.relativeStrength || {};
    const values = [rs.r20, rs.r60, rs.r120].filter(value => value !== null && value !== undefined);
    const score = values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 1) : candidate.technical?.momentum?.rpsProxy ?? null;
    const rankText = score === null ? "候选池相对强度缺失" : score >= 75 ? "候选池相对强度强" : score >= 55 ? "候选池相对强度中等" : "候选池相对强度偏弱";
    candidate.technical.relativeStrength = {
      ...rs,
      score,
      rankText,
      source: "基于当前候选池20/60/120日涨跌幅排名，不等同全市场RPS"
    };
  }
}

function buildActionList(candidates) {
  return [
    ...candidates.filter(c => c.tradePlan.state === "交易准备池").slice(0, 6).map(c => ({
      level: "可准备",
      code: c.code,
      name: c.name,
      text: `${c.name}：${c.tradePlan.buyType}，${c.tradePlan.nextAction}`,
      price: c.price,
      score: c.tradePlan.score
    })),
    ...candidates.filter(c => c.tradePlan.state === "重点跟踪池").slice(0, 6).map(c => ({
      level: "跟踪",
      code: c.code,
      name: c.name,
      text: `${c.name}：等待触发条件，建仓区间 ${c.tradePlan.entryZone}`,
      price: c.price,
      score: c.tradePlan.score
    })),
    ...candidates.filter(c => c.tradePlan.state === "暂不交易").slice(0, 5).map(c => ({
      level: "回避",
      code: c.code,
      name: c.name,
      text: `${c.name}：${c.tradePlan.risk[0] || "当前风险收益比不合适"}`,
      price: c.price,
      score: c.tradePlan.score
    }))
  ];
}

function groupCandidatesBySector(candidates) {
  const groups = [];
  for (const sector of SECTOR_CONFIG) {
    const rows = candidates.filter(c => c.focus?.area === sector.name);
    if (rows.length) groups.push({ name: sector.name, priority: sector.priority, candidates: rows.map(c => c.code), count: rows.length });
  }
  const others = candidates.filter(c => !SECTOR_CONFIG.some(s => s.name === c.focus?.area));
  if (others.length) groups.push({ name: "其它", priority: 0, candidates: others.map(c => c.code), count: others.length });
  return groups;
}

function groupBoardsBySector(boards) {
  const groups = [];
  for (const sector of SECTOR_CONFIG) {
    const rows = boards.filter(b => b.sector === sector.name);
    if (rows.length) groups.push({
      name: sector.name,
      priority: sector.priority,
      count: rows.length,
      boards: rows.map(b => ({ code: b.code, name: b.name, pct: b.pct, amountYi: b.amountYi, memberCount: b.memberCount, source: b.source, derived: b.derived })).slice(0, 12)
    });
  }
  return groups;
}

function buildUnavailableData(snapshot) {
  const candidates = snapshot.candidates || [];
  const unavailable = [];
  const missingMainFlow = candidates.filter(c => c.mainNetInflowYi === null || c.mainNetInflowYi === undefined);
  if (missingMainFlow.length) {
    unavailable.push({
      field: "候选股主力净流入",
      count: missingMainFlow.length,
      total: candidates.length,
      reason: missingMainFlow[0]?.capitalFlow?.reason || "东方财富/新浪公开资金流均未返回稳定数据",
      impact: "资金流不是硬性门槛；缺失股票保持原交易判断逻辑，资金流本项不加分也不扣分，并在个股卡片显性提示。"
    });
  }
  const derivedBoards = (snapshot.universe?.boards || []).filter(b => b.derived);
  if (derivedBoards.length) {
    unavailable.push({
      field: "新浪板块官方涨跌幅/成交额",
      count: derivedBoards.length,
      total: snapshot.universe.boards.length,
      reason: "新浪行业/概念节点返回成分股行情，但不直接返回板块级汇总指标。",
      impact: "已用成分股真实行情聚合计算板块涨跌幅、成交额、平均换手和成分股数量。"
    });
  }
  return unavailable;
}

function appendStrategyLog(snapshot) {
  let logs = [];
  try {
    if (fs.existsSync(STRATEGY_LOG_JSON)) {
      const parsed = JSON.parse(fs.readFileSync(STRATEGY_LOG_JSON, "utf8"));
      if (Array.isArray(parsed)) logs = parsed;
    }
  } catch {
    logs = [];
  }
  const entry = {
    generatedAt: snapshot.generatedAt,
    generatedAtChina: snapshot.generatedAtChina,
    candidateCount: snapshot.candidates.length,
    states: snapshot.audit.coverage.states,
    stability: snapshot.stabilitySummary?.counts || {},
    groups: snapshot.candidateGroups.map(group => ({ name: group.name, count: group.count })),
    dataQuality: snapshot.dataQuality?.unavailable || [],
    candidates: snapshot.candidates.map(candidate => ({
      code: candidate.code,
      name: candidate.name,
      price: candidate.price,
      pct: candidate.pct,
      focusArea: candidate.focus?.area,
      state: candidate.tradePlan?.state,
      layer: candidate.stability?.layer || candidate.tradePlan?.trackingLayer || "",
      score: candidate.tradePlan?.score,
      buyType: candidate.tradePlan?.buyType,
      trendStage: candidate.tradePlan?.trendStage?.stage || candidate.technical?.trendStage?.stage,
      relativeStrength: candidate.tradePlan?.relativeStrength?.score || candidate.technical?.relativeStrength?.score,
      riskReward: candidate.tradePlan?.riskReward?.ratio,
      votePass: candidate.tradePlan?.strategyVotes?.passCount,
      voteFail: candidate.tradePlan?.strategyVotes?.failCount,
      stop: candidate.tradePlan?.stop,
      takeProfit: candidate.tradePlan?.takeProfit
    }))
  };
  logs.push(entry);
  logs = logs.slice(-180);
  fs.writeFileSync(STRATEGY_LOG_JSON, JSON.stringify(logs, null, 2), "utf8");
  return logs;
}

function buildStrategyReview(logs, snapshot) {
  const current = logs[logs.length - 1];
  const previous = logs.length > 1 ? logs[logs.length - 2] : null;
  const candidates = snapshot.candidates || [];
  const avg = rows => rows.length ? round(rows.reduce((sum, item) => sum + Number(item || 0), 0) / rows.length, 2) : null;
  const byState = {};
  for (const candidate of candidates) {
    const state = candidate.tradePlan?.state || "未分类";
    if (!byState[state]) byState[state] = [];
    byState[state].push(candidate);
  }
  const stateMetrics = Object.fromEntries(Object.entries(byState).map(([state, rows]) => [state, {
    count: rows.length,
    avgScore: avg(rows.map(row => row.tradePlan?.score)),
    avgRiskReward: avg(rows.map(row => row.tradePlan?.riskReward?.ratio).filter(Number.isFinite)),
    avgRelativeStrength: avg(rows.map(row => row.tradePlan?.relativeStrength?.score || row.technical?.relativeStrength?.score).filter(Number.isFinite))
  }]));
  const previousCodes = new Set(previous?.candidates?.map(candidate => candidate.code) || []);
  const currentCodes = new Set(current?.candidates?.map(candidate => candidate.code) || []);
  const overlap = previous ? [...currentCodes].filter(code => previousCodes.has(code)).length : null;
  const observations = [];
  const suggestions = [];
  const blockedRatio = candidates.length ? (byState["暂不交易"]?.length || 0) / candidates.length : 0;
  const readyCount = byState["交易准备池"]?.length || 0;
  const trackingCount = byState["重点跟踪池"]?.length || 0;

  if (logs.length < 7) {
    observations.push("策略日志样本少于7次刷新，当前只做结构性检查，不做参数调整结论。");
  }
  if (blockedRatio > 0.75) {
    observations.push(`暂不交易占比 ${round(blockedRatio * 100, 1)}%，说明当前市场或规则偏谨慎，需要后续复盘确认是否过严。`);
    suggestions.push({
      title: "观察风险收益比和趋势阶段门槛是否过严",
      reason: "暂不交易占比持续过高会降低选股覆盖度，但短期高占比也可能只是市场结构弱。",
      proposedChange: "连续5次刷新暂不交易占比仍高于75%时，再评估是否微调风险收益比门槛或趋势阶段扣分。",
      status: "待你确认后才执行"
    });
  }
  if (readyCount + trackingCount === 0) {
    observations.push("当前没有交易准备池或重点跟踪池，需要避免强行推荐。");
  }
  if ((snapshot.dataQuality?.unavailable || []).length) {
    observations.push("存在数据源限制，相关字段不会参与硬性加减分，避免用缺失数据推导结论。");
  }
  if (previous && overlap !== null) {
    observations.push(`与上次刷新候选重合 ${overlap}/${current.candidateCount}，用于观察候选池稳定性。`);
  }

  suggestions.push({
    title: "建立后续收益回看",
    reason: "当前日志已记录信号，但还需要在1/3/5/10/20个交易日后回看表现，才能判断策略是否真的有效。",
    proposedChange: "后续增加收益追踪脚本，统计交易准备池、重点跟踪池、观察池的分层表现。",
    status: "待你确认后开发"
  });

  return {
    generatedAtChina: snapshot.generatedAtChina,
    sampleCount: logs.length,
    reviewMode: logs.length < 20 ? "样本积累期" : "可开始月度复盘",
    cadence: ["每日记录每次刷新", "每周轻复盘", "每月正式复盘", "季度调参建议", "半年框架评估"],
    guardrails: [
      "不因单日偏差自动改策略",
      "不自动改变你的行业偏好和风险偏好",
      "策略调整只生成建议，必须经你确认后执行",
      "把偏差区分为策略问题、数据问题、市场突发、执行条件未满足和不可归因"
    ],
    currentDistribution: snapshot.audit.coverage.states,
    stateMetrics,
    stability: previous ? {
      previousRefresh: previous.generatedAtChina,
      overlapWithPrevious: overlap,
      currentCount: current.candidateCount,
      previousCount: previous.candidateCount
    } : null,
    observations,
    suggestions,
    timeline: buildReviewTimeline(logs)
  };
}

function buildReviewTimeline(logs) {
  const safeLogs = (logs || []).filter(entry => entry?.generatedAt || entry?.generatedAtChina);
  return {
    daily: groupReviewEntries(safeLogs, dateKey).reverse(),
    weekly: groupReviewEntries(safeLogs, weekKey).reverse(),
    monthly: groupReviewEntries(safeLogs, monthKey).reverse()
  };
}

function groupReviewEntries(logs, keyFn) {
  const groups = new Map();
  for (const entry of logs || []) {
    const key = keyFn(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.entries()].map(([key, entries]) => summarizeReviewEntries(key, entries, "period"));
}

function summarizeReviewEntries(key, entries, type) {
  const rows = [...(entries || [])].sort((a, b) => String(a.generatedAt || a.generatedAtChina).localeCompare(String(b.generatedAt || b.generatedAtChina)));
  const latest = rows[rows.length - 1] || {};
  const candidateCounts = rows.map(row => Number(row.candidateCount)).filter(Number.isFinite);
  const avgCandidateCount = candidateCounts.length ? round(candidateCounts.reduce((sum, value) => sum + value, 0) / candidateCounts.length, 1) : null;
  const stateTotals = {};
  for (const row of rows) {
    for (const [state, count] of Object.entries(row.states || {})) {
      stateTotals[state] = (stateTotals[state] || 0) + Number(count || 0);
    }
  }
  const stateAverages = Object.fromEntries(Object.entries(stateTotals).map(([state, count]) => [state, round(count / Math.max(1, rows.length), 1)]));
  const topCandidates = [...(latest.candidates || [])]
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 8)
    .map(candidate => ({
      code: candidate.code,
      name: candidate.name,
      focusArea: candidate.focusArea,
      state: candidate.state,
      score: candidate.score,
      buyType: candidate.buyType,
      riskReward: candidate.riskReward
    }));
  const dataQuality = [...new Map(rows.flatMap(row => row.dataQuality || []).map(item => [item.field, item])).values()];
  return {
    key,
    type,
    refreshCount: rows.length,
    firstRefresh: rows[0]?.generatedAtChina || rows[0]?.generatedAt || "",
    latestRefresh: latest.generatedAtChina || latest.generatedAt || "",
    candidateCount: latest.candidateCount ?? null,
    avgCandidateCount,
    states: latest.states || {},
    stateAverages,
    groups: latest.groups || [],
    dataQuality,
    topCandidates
  };
}

function dateKey(entry) {
  const text = String(entry?.generatedAtChina || entry?.generatedAt || "");
  const match = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (match) return `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? "unknown-date" : date.toISOString().slice(0, 10);
}

function monthKey(entry) {
  return dateKey(entry).slice(0, 7);
}

function weekKey(entry) {
  const date = new Date(`${dateKey(entry)}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return "unknown-week";
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return `${date.toISOString().slice(0, 10)}周`;
}

function universeSectorCoverage(universe) {
  const counts = Object.fromEntries(SECTOR_CONFIG.map(sector => [sector.name, 0]));
  for (const stock of universe?.stocks || []) {
    const sector = Object.entries(stock.sectorScores || {}).sort((a, b) => b[1] - a[1])[0]?.[0]
      || classifySectorText([stock.name, ...(stock.boards || []).map(b => b.name)].join(" ")).sector;
    if (counts[sector] !== undefined) counts[sector] += 1;
  }
  return counts;
}

function needsUniverseFallback(universe) {
  const coverage = universeSectorCoverage(universe);
  const coveredSectors = Object.values(coverage).filter(count => count > 0).length;
  return coveredSectors < Math.max(6, SECTOR_CONFIG.length - 2);
}

function mergeUniverses(primary, fallback) {
  const boards = [...(primary.boards || [])];
  const boardKeys = new Set(boards.map(board => `${board.code}:${board.name}`));
  for (const board of fallback.boards || []) {
    const key = `${board.code}:${board.name}`;
    if (!boardKeys.has(key)) {
      boards.push(board);
      boardKeys.add(key);
    }
  }

  const stockMap = new Map((primary.stocks || []).map(stock => [stock.code, {
    ...stock,
    boards: [...(stock.boards || [])],
    sectorScores: { ...(stock.sectorScores || {}) }
  }]));
  for (const stock of fallback.stocks || []) {
    const current = stockMap.get(stock.code);
    if (!current) {
      stockMap.set(stock.code, stock);
      continue;
    }
    const existingBoards = new Set((current.boards || []).map(board => `${board.code}:${board.name}`));
    for (const board of stock.boards || []) {
      const key = `${board.code}:${board.name}`;
      if (!existingBoards.has(key)) {
        current.boards.push(board);
        existingBoards.add(key);
      }
    }
    for (const [sector, score] of Object.entries(stock.sectorScores || {})) {
      current.sectorScores[sector] = (current.sectorScores[sector] || 0) + score;
    }
    stockMap.set(stock.code, current);
  }
  return { boards, stocks: [...stockMap.values()] };
}

async function supplementMissingSectorSeeds(universe) {
  const coverage = universeSectorCoverage(universe);
  const missingCodes = [];
  const stockMap = new Map((universe.stocks || []).map(stock => [stock.code, {
    ...stock,
    boards: [...(stock.boards || [])],
    sectorScores: { ...(stock.sectorScores || {}) }
  }]));
  for (const [sector, codes] of Object.entries(SECTOR_SEED_CODES)) {
    const quota = SECTOR_CONFIG.find(item => item.name === sector)?.candidateQuota || 3;
    if ((coverage[sector] || 0) < quota) {
      for (const code of codes) {
        const current = stockMap.get(code);
        if (current) {
          current.boards.push({ name: `${sector}维护型补位池`, code: `seed-${sector}`, source: "新浪财经实时行情" });
          current.sectorScores[sector] = Math.max(current.sectorScores[sector] || 0, 3);
        } else {
          missingCodes.push(code);
        }
      }
    }
  }
  if (!missingCodes.length) return { boards: universe.boards || [], stocks: [...stockMap.values()] };

  const codes = [...new Set(missingCodes)];
  if (!codes.length) return universe;
  const rows = await guarded("新浪财经板块缺口补位实时行情", () => fetchSinaQuotes(codes.map(sinaSymbol)), []);
  const tencentMetrics = await guarded("腾讯实时行情补位换手率", () => fetchTencentQuoteMetrics(codes), {});
  const supplements = rows.map(normalizeSinaStock).map(stock => {
    const sector = Object.entries(SECTOR_SEED_CODES).find(([, codes]) => codes.includes(stock.code))?.[0] || "其它";
    const metrics = tencentMetrics[stock.code] || {};
    return {
      ...stock,
      turnover: metrics.turnover ?? stock.turnover,
      pe: metrics.pe ?? stock.pe,
      amplitude: metrics.amplitude ?? stock.amplitude,
      marketCapYi: metrics.marketCapYi ?? stock.marketCapYi,
      boards: [{ name: `${sector}维护型补位池`, code: `seed-${sector}`, source: "新浪财经实时行情" }],
      sectorScores: { [sector]: 3 }
    };
  });
  return {
    boards: universe.boards || [],
    stocks: [...stockMap.values(), ...supplements]
  };
}

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readRemovalState() {
  const state = readJsonFile(REMOVAL_STATE_JSON, { confirmedRemoved: {}, keepTracking: {}, history: [] });
  return {
    confirmedRemoved: state.confirmedRemoved || {},
    keepTracking: state.keepTracking || {},
    history: Array.isArray(state.history) ? state.history : []
  };
}

async function applyKeepTrackingUniverse(universe, removalState) {
  const keepCodes = Object.keys(removalState.keepTracking || {});
  if (!keepCodes.length) return universe;
  const stockMap = new Map((universe.stocks || []).map(stock => [stock.code, {
    ...stock,
    boards: [...(stock.boards || [])],
    sectorScores: { ...(stock.sectorScores || {}) }
  }]));
  const missingCodes = [];
  for (const code of keepCodes) {
    const current = stockMap.get(code);
    if (current) {
      current.boards.push({ name: "用户确认继续跟踪", code: "keep-tracking", source: "本地确认状态" });
      current.keepTracking = true;
    } else {
      missingCodes.push(code);
    }
  }
  if (missingCodes.length) {
    const rows = await guarded("用户确认继续跟踪股票实时行情", () => fetchSinaQuotes(missingCodes.map(sinaSymbol)), []);
    for (const stock of rows.map(normalizeSinaStock)) {
      const previous = removalState.keepTracking[stock.code] || {};
      const sector = previous.focusArea || classifySectorText(stock.name).sector;
      stockMap.set(stock.code, {
        ...stock,
        keepTracking: true,
        boards: [{ name: "用户确认继续跟踪", code: "keep-tracking", source: "本地确认状态" }],
        sectorScores: { [sector]: 4 }
      });
    }
  }
  return { boards: universe.boards || [], stocks: [...stockMap.values()] };
}

function buildRemovalReason(previousCandidate) {
  const parts = ["本次刷新未进入新的候选池前列，需要人工确认是否剔除。"];
  if (previousCandidate.tradePlan?.state) parts.push(`上次状态：${previousCandidate.tradePlan.state}`);
  if (previousCandidate.tradePlan?.score !== undefined) parts.push(`上次评分：${previousCandidate.tradePlan.score}`);
  if (previousCandidate.tradePlan?.buyType) parts.push(`上次买点：${previousCandidate.tradePlan.buyType}`);
  if (previousCandidate.technical?.trendStage?.stage) parts.push(`上次趋势：${previousCandidate.technical.trendStage.stage}`);
  if (previousCandidate.mainNetInflowYi !== null && previousCandidate.mainNetInflowYi !== undefined) parts.push(`上次主力净流入：${previousCandidate.mainNetInflowYi}亿`);
  if ((previousCandidate.tradePlan?.risk || []).length) parts.push(`主要风险：${previousCandidate.tradePlan.risk.slice(0, 2).join("；")}`);
  return parts.join("；");
}

function buildContinuity(previousSnapshot, snapshot, removalState) {
  const previousCandidates = previousSnapshot?.candidates || [];
  const currentCodes = new Set((snapshot.candidates || []).map(candidate => candidate.code));
  const confirmedRemoved = removalState.confirmedRemoved || {};
  const keepTracking = removalState.keepTracking || {};
  const pendingRemovals = [];
  const retained = [];
  for (const previous of previousCandidates) {
    if (currentCodes.has(previous.code)) {
      if (keepTracking[previous.code]) retained.push({ code: previous.code, name: previous.name, status: "继续跟踪且仍在候选池" });
      continue;
    }
    if (confirmedRemoved[previous.code]) continue;
    pendingRemovals.push({
      code: previous.code,
      name: previous.name,
      previousRefresh: previousSnapshot.generatedAtChina || previousSnapshot.generatedAt,
      previousState: previous.tradePlan?.state || "",
      previousScore: previous.tradePlan?.score ?? null,
      previousBuyType: previous.tradePlan?.buyType || "",
      previousSector: previous.focus?.area || "",
      reason: buildRemovalReason(previous),
      nextStep: "请确认：同意剔除则写入剔除记录；不同意则进入继续跟踪池，后续刷新会保留并重新分析。",
      previousSnapshot: {
        price: previous.price,
        pct: previous.pct,
        mainNetInflowYi: previous.mainNetInflowYi,
        stop: previous.tradePlan?.stop,
        takeProfit: previous.tradePlan?.takeProfit,
        support: (previous.tradePlan?.support || []).slice(0, 5),
        risk: (previous.tradePlan?.risk || []).slice(0, 5)
      }
    });
  }
  for (const current of snapshot.candidates || []) {
    if (current.stability?.layer !== "待确认剔除") continue;
    if (confirmedRemoved[current.code]) continue;
    pendingRemovals.push({
      code: current.code,
      name: current.name,
      previousRefresh: previousSnapshot?.generatedAtChina || previousSnapshot?.generatedAt || "",
      previousState: current.stability?.previousState || "",
      previousScore: current.stability?.previousScore ?? null,
      previousBuyType: current.tradePlan?.buyType || "",
      previousSector: current.focus?.area || "",
      reason: current.stability?.reason || buildRemovalReason(current),
      nextStep: "该股仍保留在推荐追踪中，但暂停新开仓。请确认是否踢出；不同意则继续留在核心跟踪/观察池等待修复。",
      previousSnapshot: {
        price: current.price,
        pct: current.pct,
        mainNetInflowYi: current.mainNetInflowYi,
        stop: current.tradePlan?.stop,
        takeProfit: current.tradePlan?.takeProfit,
        support: (current.tradePlan?.support || []).slice(0, 5),
        risk: (current.tradePlan?.risk || []).slice(0, 5)
      }
    });
  }
  return {
    previousRefresh: previousSnapshot?.generatedAtChina || previousSnapshot?.generatedAt || "",
    pendingRemovalCount: pendingRemovals.length,
    pendingRemovals,
    retainedByUser: Object.values(keepTracking),
    confirmedRemovedCount: Object.keys(confirmedRemoved).length,
    confirmedRemoved: Object.values(confirmedRemoved).slice(-50),
    retained
  };
}

function dateOnly(value) {
  const text = String(value || "");
  const match = text.match(/\d{4}[-/]\d{2}[-/]\d{2}/);
  if (match) return match[0].replace(/\//g, "-");
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00+08:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function firstPointOnOrAfter(points, targetDate) {
  return points.find(point => point.date >= targetDate) || null;
}

function calculateTrackingPerformance(record) {
  const points = (record.priceHistory || []).filter(point => Number.isFinite(Number(point.close))).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const firstPrice = Number(record.firstPrice);
  const latest = points[points.length - 1] || null;
  if (!firstPrice || !latest) {
    return {
      currentReturnPct: null,
      maxGainPct: null,
      maxDrawdownPct: null,
      oneWeekPct: null,
      oneMonthPct: null,
      twoMonthPct: null,
      hitStop: false,
      hitTakeProfit: false
    };
  }
  const returns = points.map(point => round((Number(point.close) / firstPrice - 1) * 100, 2));
  const stop = Number(record.initialPlan?.stop);
  const takeProfit = Number(record.initialPlan?.takeProfit);
  const pctAt = days => {
    const point = firstPointOnOrAfter(points, addDays(record.firstDate, days));
    return point ? round((Number(point.close) / firstPrice - 1) * 100, 2) : null;
  };
  return {
    currentReturnPct: round((Number(latest.close) / firstPrice - 1) * 100, 2),
    maxGainPct: Math.max(...returns),
    maxDrawdownPct: Math.min(...returns),
    oneWeekPct: pctAt(7),
    oneMonthPct: pctAt(30),
    twoMonthPct: pctAt(60),
    hitStop: Number.isFinite(stop) ? points.some(point => Number(point.low ?? point.close) <= stop) : false,
    hitTakeProfit: Number.isFinite(takeProfit) ? points.some(point => Number(point.high ?? point.close) >= takeProfit) : false,
    latestDate: latest.date,
    latestClose: latest.close
  };
}

function updateRecommendationTracking(snapshot, removalState) {
  const existing = readJsonFile(RECOMMENDATION_TRACKING_JSON, { version: "recommendation-tracking-v0.1", records: {}, calendar: {} });
  const records = existing.records || {};
  const now = snapshot.generatedAt;
  const today = dateOnly(snapshot.generatedAtChina || snapshot.generatedAt);
  const confirmedRemoved = removalState.confirmedRemoved || {};

  for (const candidate of snapshot.candidates || []) {
    if (confirmedRemoved[candidate.code]) continue;
    const record = records[candidate.code] || {
      code: candidate.code,
      name: candidate.name,
      firstRecommendedAt: now,
      firstRecommendedAtChina: snapshot.generatedAtChina,
      firstDate: candidate.technical?.lastDate || today,
      firstPrice: candidate.price,
      firstState: candidate.tradePlan?.state,
      firstScore: candidate.tradePlan?.score,
      firstLayer: candidate.stability?.layer || candidate.tradePlan?.trackingLayer,
      firstReason: (candidate.tradePlan?.support || []).slice(0, 4),
      sector: candidate.focus?.area || "",
      active: true,
      recommendations: [],
      priceHistory: [],
      initialPlan: {
        buyType: candidate.tradePlan?.buyType,
        entryZone: candidate.tradePlan?.entryZone,
        stop: candidate.tradePlan?.stop,
        takeProfit: candidate.tradePlan?.takeProfit,
        riskReward: candidate.tradePlan?.riskReward?.ratio
      }
    };
    record.name = candidate.name;
    record.active = true;
    record.lastSeenAt = now;
    record.lastSeenAtChina = snapshot.generatedAtChina;
    record.currentState = candidate.tradePlan?.state;
    record.currentScore = candidate.tradePlan?.score;
    record.currentLayer = candidate.stability?.layer || candidate.tradePlan?.trackingLayer || record.currentLayer;
    record.currentLayerReason = candidate.stability?.reason || "";
    record.currentPrice = candidate.price;
    record.currentSector = candidate.focus?.area || record.sector;
    record.lastPlan = {
      buyType: candidate.tradePlan?.buyType,
      action: candidate.tradePlan?.action,
      nextAction: candidate.tradePlan?.nextAction,
      stop: candidate.tradePlan?.stop,
      takeProfit: candidate.tradePlan?.takeProfit,
      riskReward: candidate.tradePlan?.riskReward?.ratio
    };
    record.recommendations.push({
      at: now,
      atChina: snapshot.generatedAtChina,
      date: candidate.technical?.lastDate || today,
      price: candidate.price,
      pct: candidate.pct,
      state: candidate.tradePlan?.state,
      score: candidate.tradePlan?.score,
      layer: candidate.stability?.layer || candidate.tradePlan?.trackingLayer || "",
      layerReason: candidate.stability?.reason || "",
      sector: candidate.focus?.area,
      buyType: candidate.tradePlan?.buyType,
      reason: (candidate.tradePlan?.support || []).slice(0, 5),
      risk: (candidate.tradePlan?.risk || []).slice(0, 5)
    });
    record.recommendations = record.recommendations.slice(-240);
    const point = {
      date: candidate.technical?.lastDate || today,
      at: now,
      close: candidate.price,
      open: candidate.open,
      high: candidate.high,
      low: candidate.low,
      pct: candidate.pct,
      state: candidate.tradePlan?.state,
      score: candidate.tradePlan?.score,
      layer: candidate.stability?.layer || candidate.tradePlan?.trackingLayer || "",
      mainNetInflowYi: candidate.mainNetInflowYi
    };
    const existingIndex = record.priceHistory.findIndex(item => item.date === point.date);
    if (existingIndex >= 0) record.priceHistory[existingIndex] = point;
    else record.priceHistory.push(point);
    record.priceHistory = record.priceHistory
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-260);
    record.performance = calculateTrackingPerformance(record);
    records[candidate.code] = record;
  }

  for (const [code, removal] of Object.entries(confirmedRemoved)) {
    if (!records[code]) continue;
    records[code].active = false;
    records[code].stoppedAt = removal.decidedAt || records[code].stoppedAt || now;
    records[code].stoppedReason = removal.reason || records[code].stoppedReason || "已确认剔除";
    records[code].performance = calculateTrackingPerformance(records[code]);
  }

  const calendar = existing.calendar || {};
  const todayCodes = (snapshot.candidates || []).map(candidate => candidate.code);
  calendar[today] = [...new Set([...(calendar[today] || []), ...todayCodes])];

  const output = {
    version: "recommendation-tracking-v0.1",
    updatedAt: now,
    updatedAtChina: snapshot.generatedAtChina,
    records,
    calendar
  };
  fs.writeFileSync(RECOMMENDATION_TRACKING_JSON, JSON.stringify(output, null, 2), "utf8");

  const recordList = Object.values(records).sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return String(b.lastSeenAt || b.firstRecommendedAt).localeCompare(String(a.lastSeenAt || a.firstRecommendedAt));
  });
  return {
    updatedAtChina: output.updatedAtChina,
    total: recordList.length,
    active: recordList.filter(record => record.active).length,
    stopped: recordList.filter(record => !record.active).length,
    calendar: Object.fromEntries(Object.entries(calendar).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 90)),
    records: recordList.map(record => ({
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
      recommendations: record.recommendations.slice(-12)
    }))
  };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const previousSnapshot = readJsonFile(SNAPSHOT_JSON, null);
  const removalState = readRemovalState();

  const indicesRows = await guarded("新浪财经A股指数", () => fetchSinaQuotes(["sh000001", "sz399001", "sz399006", "sh000300", "sh000688"]), []);
  const indices = indicesRows.map(normalizeIndex);

  let universe = await guarded("东方财富科技/能源板块股票池", buildFocusUniverse, { boards: [], stocks: [] });
  let universeMethodNote = "";
  if (universe.stocks.length && needsUniverseFallback(universe)) {
    const sinaUniverse = await guarded("新浪财经多板块股票池补充", fetchSinaFocusUniverse, { boards: [], stocks: [] });
    if (sinaUniverse.stocks.length) {
      universe = mergeUniverses(universe, sinaUniverse);
      universeMethodNote = "东方财富板块成分股部分失败，已合并新浪财经行业/概念节点补齐多板块股票池。行情、K线、财报、公告仍重新抓取。";
    }
  }
  if (!universe.stocks.length) {
    universe = await guarded("新浪财经科技/能源行业股票池", fetchSinaFocusUniverse, { boards: [], stocks: [] });
    if (universe.stocks.length) {
      universeMethodNote = "东方财富板块入口不可用，使用新浪财经行业/概念节点筛选科技、锂电、储能相关股票池。行情、K线、财报、公告仍重新抓取。";
    }
  }
  if (universe.stocks.length) {
    universe = await supplementMissingSectorSeeds(universe);
  }
  if (universe.stocks.length) {
    universe = await applyKeepTrackingUniverse(universe, removalState);
  }
  if (universe.stocks.length > 1000) {
    fs.writeFileSync(UNIVERSE_CACHE_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), generatedAtChina: todayChina(), universe }, null, 2), "utf8");
  }
  if (!universe.stocks.length && fs.existsSync(UNIVERSE_CACHE_JSON)) {
    try {
      const cached = JSON.parse(fs.readFileSync(UNIVERSE_CACHE_JSON, "utf8"));
      if (cached?.universe?.stocks?.length) {
        universe = cached.universe;
        universeMethodNote = `实时板块入口失败，使用最近一次成功缓存的科技/能源股票池（缓存时间 ${cached.generatedAtChina}）。行情、K线、财报、公告仍重新抓取。`;
        audit.sources.push({ name: "本地科技/能源股票池缓存", ok: true });
      }
    } catch (error) {
      audit.failures.push({ name: "本地科技/能源股票池缓存", error: String(error.message || error) });
    }
  }
  if (!universe.stocks.length) {
    const fallback = await guarded("新浪财经重点观察池备用", fetchFallbackWatchlist, []);
    universe = { boards: [], stocks: fallback.map(s => ({ ...s, boards: [{ name: "重点观察池备用", code: "fallback" }] })) };
  }

  const keepCodes = new Set([
    ...Object.keys(removalState.keepTracking || {}),
    ...buildStabilityForceCodes(previousSnapshot, removalState)
  ]);
  const candidates = await enrichCandidates(universe.stocks, keepCodes);
  const stabilitySummary = assignStabilityLayers(candidates, previousSnapshot, removalState);
  const snapshot = {
    version: "trading-assistant-v0.1",
    generatedAt: new Date().toISOString(),
    generatedAtChina: todayChina(),
    scope: "全板块交易助理：科技最高权重，其它保留板块各约3支候选",
    disclaimer: "仅做决策辅助，不构成投资建议；所有买卖点必须结合账户风险承受能力与人工确认。",
    sources: [
      { name: "东方财富板块与成分股行情", url: "https://quote.eastmoney.com/center/boardlist.html" },
      { name: "东方财富复权K线", url: "https://quote.eastmoney.com/" },
      { name: "东方财富财务报表", url: "https://data.eastmoney.com/" },
      { name: "东方财富公告", url: "https://data.eastmoney.com/notices/" },
      { name: "东方财富F10", url: "https://data.eastmoney.com/" },
      { name: "新浪财经指数与备用行情", url: "https://finance.sina.com.cn/" },
      { name: "新浪财经K线备用源", url: "https://money.finance.sina.com.cn/" },
      { name: "新浪资金流备用源", url: "https://vip.stock.finance.sina.com.cn/moneyflow/" },
      { name: "腾讯证券K线第二备用源", url: "https://gu.qq.com/" },
      { name: "巨潮资讯公告备用源", url: "http://www.cninfo.com.cn/" },
      { name: "新浪财经板块缺口补位实时行情", url: "https://finance.sina.com.cn/" },
      { name: "腾讯证券补位换手率", url: "https://gu.qq.com/" }
    ],
    preference: {
      focus: FOCUS.focus,
      primarySector: FOCUS.primarySector,
      sectorConfig: SECTOR_CONFIG.map(s => ({ name: s.name, priority: s.priority, candidateQuota: s.candidateQuota, boardQuota: s.boardQuota })),
      includeKeywords: FOCUS.include
    },
    market: {
      indices,
      note: "宏观与全市场模块暂不展开，本页只保留交易助理需要的市场温度参考。"
    },
    universe: {
      boards: universe.boards.slice(0, 80),
      stockCount: universe.stocks.length,
      method: universeMethodNote || (universe.boards.length
        ? "从东方财富行业/概念板块中筛选科技、锂电、储能相关板块，再抓取真实成分股。"
        : "主数据源不可用，使用新浪财经重点观察池备用。")
    },
    candidates,
    stabilityPolicy: stabilitySummary.policy,
    stabilitySummary,
    candidateGroups: groupCandidatesBySector(candidates),
    sectorGroups: groupBoardsBySector(universe.boards),
    actionList: buildStableActionList(candidates),
    continuity: null,
    audit: {
      ...audit,
      coverage: {
        boards: universe.boards.length,
        universeStocks: universe.stocks.length,
        candidates: candidates.length,
        withDailyK: candidates.filter(c => c.technical?.lastDate).length,
        with30mK: candidates.filter(c => c.technical?.m30?.lastDate).length,
        with5mK: candidates.filter(c => c.technical?.m5?.lastDate).length,
        withFinancial: candidates.filter(c => c.financial?.reportDate).length,
        withAnnouncements: candidates.filter(c => c.announcements?.latest?.length).length,
        failures: audit.failures.length,
        states: candidates.reduce((acc, c) => {
          acc[c.tradePlan.state] = (acc[c.tradePlan.state] || 0) + 1;
          return acc;
        }, {})
      }
    }
  };

  snapshot.dataQuality = {
    unavailable: buildUnavailableData(snapshot)
  };
  snapshot.continuity = buildContinuity(previousSnapshot, snapshot, removalState);
  snapshot.recommendationTracking = updateRecommendationTracking(snapshot, removalState);
  const strategyLogs = appendStrategyLog(snapshot);
  snapshot.strategyReview = buildStrategyReview(strategyLogs, snapshot);

  fs.writeFileSync(SNAPSHOT_JSON, JSON.stringify(snapshot, null, 2), "utf8");
  fs.writeFileSync(SNAPSHOT_JS, `window.TRADING_ASSISTANT_DATA = ${JSON.stringify(snapshot, null, 2)};\n`, "utf8");
  console.log(JSON.stringify(snapshot.audit.coverage, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
