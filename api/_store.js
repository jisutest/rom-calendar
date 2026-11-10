// 저장소: Vercel에 연결한 Upstash Redis(REST)를 쓰고,
// 환경 변수가 없으면(로컬 개발) 메모리에 저장한다.
// 컬렉션마다 Redis 해시 하나 (rom:events, rom:fixed, rom:expenses).
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const mem = { hashes: new Map(), counters: new Map() };

async function redis(cmd) {
  if (!URL_ || !TOKEN) return memRedis(cmd);
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
    case "HSET": h.set(args[0], args[1]); return 1;
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

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return null; } }
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 64 * 1024) return null; }
  try { return JSON.parse(raw || "null"); } catch { return null; }
}

// GET 목록 / POST 추가 / PUT ?id= 고치기 / DELETE ?id= 지우기 — 모두 가족 비밀번호 필요
export function makeHandler({ key, clean, max, listName }) {
  const store = makeStore(key);
  return async function handler(req, res) {
    try {
      if (!(await checkAuth(req, res))) return;
      const id = new URL(req.url, "http://x").searchParams.get("id");
      if (req.method === "GET") return send(res, 200, { [listName]: await store.all() });
      if (req.method === "POST") {
        const v = clean(await readBody(req));
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
  return { name, amount, category: cat(b.category), cycle, day, payMonth, from, to, memo: String(b.memo || "").trim().slice(0, 200) };
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
