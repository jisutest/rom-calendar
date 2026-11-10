// 일정 저장소: Vercel에 연결한 Upstash Redis(REST)를 쓰고,
// 환경 변수가 없으면(로컬 개발) 메모리에 저장한다.
import { timingSafeEqual, createHash } from "node:crypto";

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const KEY = "rom:events";
const mem = { hash: new Map(), counters: new Map() };

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
  switch (op) {
    case "HGETALL": return [...mem.hash].flat();
    case "HSET": mem.hash.set(args[0], args[1]); return 1;
    case "HEXISTS": return mem.hash.has(args[0]) ? 1 : 0;
    case "HDEL": return mem.hash.delete(args[0]) ? 1 : 0;
    case "HLEN": return mem.hash.size;
    case "INCR": { const v = (mem.counters.get(key) || 0) + 1; mem.counters.set(key, v); return v; }
    case "EXPIRE": return 1;
    case "GET": return mem.counters.get(key) ?? null;
    case "DEL": mem.counters.delete(key); return 1;
    default: throw new Error("unsupported " + op);
  }
}

export const store = {
  async all() {
    const flat = (await redis(["HGETALL", KEY])) || [];
    const out = [];
    for (let i = 0; i < flat.length; i += 2) {
      try { out.push({ id: flat[i], ...JSON.parse(flat[i + 1]) }); } catch {}
    }
    return out;
  },
  exists: async id => (await redis(["HEXISTS", KEY, id])) === 1,
  count: async () => Number(await redis(["HLEN", KEY])) || 0,
  put: (id, ev) => redis(["HSET", KEY, id, JSON.stringify(ev)]),
  del: id => redis(["HDEL", KEY, id]),
};

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

// ---------- 입력 검사 ----------
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const WHO = ["dad", "mom", "romi"];
const REPEAT = ["none", "weekly", "monthly", "yearly"];

export function clean(b) {
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
