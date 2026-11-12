// 저장소: Vercel에 연결한 Upstash Redis(REST)를 쓴다.
// 로컬 개발(환경 변수 없음)에서만 메모리에 저장하고, Vercel에서 저장소가 없으면 저장을 거부한다
// (메모리 저장은 배포·재시작 때 사라지기 때문).
// 컬렉션마다 Redis 해시 하나 (rom:events, rom:fixed, rom:expenses, rom:assets).
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";

// Vercel이 연결할 때 붙이는 이름 앞부분(KV_, STORAGE_, UPSTASH_ 등)이 달라도 찾는다
function findRedisEnv(env) {
  const pairs = [["KV_REST_API_URL", "KV_REST_API_TOKEN"], ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]];
  for (const k of Object.keys(env).sort()) {
    let m;
    if ((m = k.match(/^(.*)_REST_API_URL$/))) pairs.push([k, `${m[1]}_REST_API_TOKEN`]);
    if ((m = k.match(/^(.*)_REDIS_REST_URL$/))) pairs.push([k, `${m[1]}_REDIS_REST_TOKEN`]);
  }
  for (const [u, t] of pairs) if (env[u] && env[t]) return { url: env[u], token: env[t], name: u };
  return null;
}
const FOUND = findRedisEnv(process.env);
const URL_ = FOUND && FOUND.url;
const TOKEN = FOUND && FOUND.token;
const ON_VERCEL = !!process.env.VERCEL;

// 비밀번호 없이 볼 수 있는 저장소 상태 (값은 빼고 이름만)
export async function storageStatus() {
  const names = Object.keys(process.env).filter(k => /KV|REDIS|UPSTASH|REST_API/i.test(k)).sort();
  if (!URL_ || !TOKEN) return { storage: ON_VERCEL ? "missing" : "memory", envNames: names };
  try { await redis(["PING"]); return { storage: "redis", via: FOUND.name, envNames: names }; }
  catch (e) { return { storage: "error", via: FOUND.name, envNames: names, error: String(e.message || e).slice(0, 120) }; }
}
const mem = { hashes: new Map(), counters: new Map() };

async function redis(cmd) {
  if (!URL_ || !TOKEN) {
    if (ON_VERCEL) { const e = new Error("no_db"); e.code = "no_db"; throw e; }
    return memRedis(cmd);
  }
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `redis ${r.status}`);
  return j.result;
}

function memRedis([op, key, ...args]) {
  if (!mem.hashes.has(key) && op.startsWith("H")) mem.hashes.set(key, new Map());
  const h = mem.hashes.get(key);
  switch (op) {
    case "HGETALL": return [...h].flat();
    case "HSET": for (let i = 0; i < args.length; i += 2) h.set(args[i], args[i + 1]); return args.length / 2;
    case "HEXISTS": return h.has(args[0]) ? 1 : 0;
    case "HDEL": return h.delete(args[0]) ? 1 : 0;
    case "HLEN": return h.size;
    case "INCR": { const v = (mem.counters.get(key) || 0) + 1; mem.counters.set(key, v); return v; }
    case "EXPIRE": return 1;
    case "GET": return mem.counters.get(key) ?? null;
    default: throw new Error("unsupported " + op);
  }
}

function makeStore(key) {
  return {
    async all() {
      const flat = (await redis(["HGETALL", key])) || [];
      const out = [];
      for (let i = 0; i < flat.length; i += 2) {
        try { out.push({ id: flat[i], ...JSON.parse(flat[i + 1]) }); } catch {}
      }
      return out;
    },
    exists: async id => (await redis(["HEXISTS", key, id])) === 1,
    count: async () => Number(await redis(["HLEN", key])) || 0,
    put: (id, v) => redis(["HSET", key, id, JSON.stringify(v)]),
    putMany: pairs => redis(["HSET", key, ...pairs.flatMap(([id, v]) => [id, JSON.stringify(v)])]),
    del: id => redis(["HDEL", key, id]),
  };
}

// ---------- 가족 비밀번호 ----------
const MAX_FAILS = 20;          // 15분 동안 IP당 허용하는 틀린 시도
const WINDOW_SEC = 15 * 60;
const digest = s => createHash("sha256").update(String(s)).digest();

export async function checkAuth(req, res) {
  const pw = process.env.FAMILY_PASSWORD;
  if (!pw) { send(res, 500, { error: "not_configured", message: "서버에 FAMILY_PASSWORD가 설정되지 않았어요." }); return false; }
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  const failKey = `rom:fail:${ip}`;
  const fails = Number(await redis(["GET", failKey])) || 0;
  if (fails >= MAX_FAILS) { send(res, 429, { error: "too_many", message: "비밀번호를 너무 많이 틀렸어요. 15분 뒤에 다시 시도해 주세요." }); return false; }
  const given = req.headers["x-family-key"];
  const ok = typeof given === "string" && given.length > 0 && timingSafeEqual(digest(given), digest(pw));
  if (!ok) {
    const n = await redis(["INCR", failKey]);
    if (n === 1) await redis(["EXPIRE", failKey, WINDOW_SEC]);
    send(res, 401, { error: "unauthorized", message: "가족 비밀번호가 맞지 않아요." });
    return false;
  }
  return true;
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

const MAX_BODY = 1024 * 1024; // 여러 건 한꺼번에 올리기 때문에 1MB까지
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return null; } }
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) return null; }
  try { return JSON.parse(raw || "null"); } catch { return null; }
}

// GET 목록 / POST 추가 (또는 {items:[...]}로 여러 건) / PUT ?id= 고치기 / DELETE ?id= 지우기 — 모두 가족 비밀번호 필요
const BULK_MAX = 1000;
export function makeHandler({ key, clean, max, listName }) {
  const store = makeStore(key);
  return async function handler(req, res) {
    try {
      if (!(await checkAuth(req, res))) return;
      const id = new URL(req.url, "http://x").searchParams.get("id");
      if (req.method === "GET") return send(res, 200, { [listName]: await store.all() });
      if (req.method === "POST") {
        const body = await readBody(req);
        if (body && Array.isArray(body.items)) {
          if (body.items.length > BULK_MAX) return send(res, 413, { error: "too_big", message: `한 번에 ${BULK_MAX}건까지 올릴 수 있어요.` });
          const ok = body.items.map(clean).filter(Boolean);
          if (!ok.length) return send(res, 400, { error: "invalid", message: "올릴 수 있는 줄이 없어요." });
          if ((await store.count()) + ok.length > max) return send(res, 507, { error: "full", message: "저장 공간이 가득 찼어요. 오래된 항목을 지워 주세요." });
          const now = Date.now();
          await store.putMany(ok.map(v => [randomUUID(), { ...v, createdAt: now, updatedAt: now }]));
          return send(res, 201, { added: ok.length, skipped: body.items.length - ok.length });
        }
        const v = clean(body);
        if (!v) return send(res, 400, { error: "invalid", message: "입력한 내용이 올바르지 않아요." });
        if ((await store.count()) >= max) return send(res, 507, { error: "full", message: "저장 공간이 가득 찼어요. 오래된 항목을 지워 주세요." });
        const now = Date.now(), newId = randomUUID();
        await store.put(newId, { ...v, createdAt: now, updatedAt: now });
        return send(res, 201, { id: newId });
      }
      if (req.method === "PUT") {
        if (!id || !(await store.exists(id))) return send(res, 404, { error: "not_found", message: "이미 지워진 항목이에요." });
        const body = await readBody(req);
        const v = clean(body);
        if (!v) return send(res, 400, { error: "invalid", message: "입력한 내용이 올바르지 않아요." });
        await store.put(id, { ...v, createdAt: Number(body.createdAt) || Date.now(), updatedAt: Date.now() });
        return send(res, 200, { id });
      }
      if (req.method === "DELETE") {
        if (!id) return send(res, 400, { error: "invalid", message: "지울 항목을 찾지 못했어요." });
        await store.del(id);
        return send(res, 200, { id });
      }
      res.setHeader("Allow", "GET, POST, PUT, DELETE");
      return send(res, 405, { error: "method" });
    } catch (e) {
      console.error(e);
      if (e.code === "no_db") return send(res, 503, { error: "no_db", message: "저장소(DB)가 연결되지 않아 저장할 수 없어요. Vercel의 Storage에서 Upstash를 이 프로젝트에 연결한 뒤 다시 배포해 주세요." });
      return send(res, 500, { error: "server", message: "서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요." });
    }
  };
}

// ---------- 입력 검사 ----------
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const WHO = ["dad", "mom", "romi"];
const REPEAT = ["none", "weekly", "monthly", "yearly"];
export const CATEGORIES = ["주거·관리비", "통신", "보험", "육아·로미", "교육", "구독", "교통·차량", "식비", "생활용품", "의료", "경조사", "대출·이자", "용돈", "기타"];
const money = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 && n <= 1e10 ? n : 0; };
const cat = v => (CATEGORIES.includes(v) ? v : "기타");

export function cleanEvent(b) {
  if (!b || typeof b !== "object") return null;
  const title = String(b.title || "").trim().slice(0, 80);
  const who = Array.isArray(b.who) ? WHO.filter(w => b.who.includes(w)) : [];
  const start = String(b.start || "");
  const end = String(b.end || start);
  if (!title || !who.length || !DATE.test(start) || !DATE.test(end) || end < start) return null;
  const repeat = REPEAT.includes(b.repeat) ? b.repeat : "none";
  const until = repeat !== "none" && DATE.test(String(b.until || "")) ? String(b.until) : "";
  const time = TIME.test(String(b.time || "")) ? String(b.time) : "";
  const exdates = Array.isArray(b.exdates) ? [...new Set(b.exdates.map(String).filter(d => DATE.test(d)))].slice(0, 300) : [];
  const memo = String(b.memo || "").trim().slice(0, 500);
  return { title, who, start, end, time, repeat, until, memo, exdates };
}

// 고정비: 매월(또는 매년 특정 달) 나가는 돈
export function cleanFixed(b) {
  if (!b || typeof b !== "object") return null;
  const name = String(b.name || "").trim().slice(0, 40);
  const amount = money(b.amount);
  const cycle = b.cycle === "yearly" ? "yearly" : "monthly";
  const day = Math.min(31, Math.max(1, Math.round(Number(b.day)) || 1));
  const payMonth = Math.min(12, Math.max(1, Math.round(Number(b.payMonth)) || 1));
  const from = MONTH.test(String(b.from || "")) ? String(b.from) : "";
  const to = MONTH.test(String(b.to || "")) ? String(b.to) : "";
  if (!name || !amount || !from || (to && to < from)) return null;
  const who = Array.isArray(b.who) ? WHO.filter(w => b.who.includes(w)) : [];
  return { name, amount, category: cat(b.category), cycle, day, payMonth, from, to, who, memo: String(b.memo || "").trim().slice(0, 200) };
}

// 변동 지출: 그날그날 쓴 돈
export function cleanExpense(b) {
  if (!b || typeof b !== "object") return null;
  const date = String(b.date || "");
  const amount = money(b.amount);
  if (!DATE.test(date) || !amount) return null;
  const who = Array.isArray(b.who) ? WHO.filter(w => b.who.includes(w)) : [];
  return { date, amount, category: cat(b.category), who, memo: String(b.memo || "").trim().slice(0, 100) };
}

// 자산: 지금 가진 돈과 빚. 적금은 매달 넣는 돈·시작 달·기간으로 잔액을 자동 계산한다.
const whole = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n <= 1e12 ? n : null; };
// 대출 상환 한 번: 날짜, 갚은 원금, 낸 이자
function cleanRepay(r) {
  if (!r || typeof r !== "object" || !DATE.test(String(r.date || ""))) return null;
  const principal = whole(r.principal) || 0, interest = whole(r.interest) || 0;
  if (!principal && !interest) return null;
  const id = /^[a-z0-9]{1,16}$/.test(String(r.id || "")) ? String(r.id) : randomUUID().slice(0, 8);
  return { id, date: String(r.date), principal, interest, memo: String(r.memo || "").trim().slice(0, 60) };
}
const ASSET_KINDS =["cash", "saving", "invest", "realestate", "pension", "etc", "debt"];
const OWNERS = ["dad", "mom", "romi", "family"];
export function cleanAsset(b) {
  if (!b || typeof b !== "object") return null;
  const name = String(b.name || "").trim().slice(0, 40);
  const kind = ASSET_KINDS.includes(b.kind) ? b.kind : "etc";
  const owner = OWNERS.includes(b.owner) ? b.owner : "family";
  const amount = Math.round(Number(b.amount)) || 0;
  if (!name || amount < 0 || amount > 1e12) return null;
  const out = { name, kind, owner, amount, memo: String(b.memo || "").trim().slice(0, 200) };
  if (kind === "saving") {
    out.monthly = money(b.monthly);
    out.start = MONTH.test(String(b.start || "")) ? String(b.start) : "";
    out.months = Math.min(600, Math.max(0, Math.round(Number(b.months)) || 0));
    const rate = Number(b.rate);
    out.rate = Number.isFinite(rate) && rate >= 0 && rate <= 30 ? Math.round(rate * 100) / 100 : 0;
    out.auto = !!(b.auto && out.monthly && out.start);
    if (!out.auto && !amount && !out.monthly) return null;
  } else if (kind === "invest") {
    // 투자: 달마다 투자 원금(p)·평가금액(v)을 적어 수익률을 본다 (최근 120개월)
    out.log = {};
    if (b.log && typeof b.log === "object") {
      for (const k of Object.keys(b.log).filter(k => MONTH.test(k)).sort().slice(-120)) {
        const r = b.log[k] || {}, p = whole(r.p), v = whole(r.v);
        if (p != null && v != null && (p || v)) out.log[k] = { p, v };
      }
    }
    if (!amount && !Object.keys(out.log).length) return null;
  } else if (kind === "debt") {
    // 대출: 처음 빌린 돈·금리와 상환 이력. 다 갚으면 남은 빚 0도 허용
    out.orig = money(b.orig);
    const rate = Number(b.rate);
    out.rate = Number.isFinite(rate) && rate >= 0 && rate <= 30 ? Math.round(rate * 100) / 100 : 0;
    out.repays = (Array.isArray(b.repays) ? b.repays : []).map(cleanRepay).filter(Boolean)
      .sort((x, y) => x.date.localeCompare(y.date)).slice(-600);
    if (!amount && !out.orig) return null;
  } else if (!amount) return null;
  // 달마다 마지막으로 적은 금액 (순자산 추이용, 최근 120개월)
  const hist = {};
  if (b.history && typeof b.history === "object") {
    for (const k of Object.keys(b.history).filter(k => MONTH.test(k)).sort().slice(-120)) {
      const v = Math.round(Number(b.history[k]));
      if (Number.isFinite(v) && v >= 0 && v <= 1e12) hist[k] = v;
    }
  }
  out.history = hist;
  return out;
}
