// GET    /api/events          → 전체 일정
// POST   /api/events          → 새 일정 (본문: 일정)
// PUT    /api/events?id=...   → 일정 고치기 (본문: 일정 전체)
// DELETE /api/events?id=...   → 일정 지우기
// 모든 요청은 x-family-key 헤더에 가족 비밀번호가 있어야 한다.
import { randomUUID } from "node:crypto";
import { store, checkAuth, send, clean } from "./_store.js";

const MAX_EVENTS = 5000;

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return null; } }
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 64 * 1024) return null; }
  try { return JSON.parse(raw || "null"); } catch { return null; }
}

export default async function handler(req, res) {
  try {
    if (!(await checkAuth(req, res))) return;
    const id = new URL(req.url, "http://x").searchParams.get("id");

    if (req.method === "GET") return send(res, 200, { events: await store.all() });

    if (req.method === "POST") {
      const ev = clean(await readBody(req));
      if (!ev) return send(res, 400, { error: "invalid", message: "일정 내용이 올바르지 않아요." });
      if ((await store.count()) >= MAX_EVENTS) return send(res, 507, { error: "full", message: "일정이 너무 많아요. 지난 일정을 지워 주세요." });
      const now = Date.now();
      const newId = randomUUID();
      await store.put(newId, { ...ev, createdAt: now, updatedAt: now });
      return send(res, 201, { id: newId });
    }

    if (req.method === "PUT") {
      if (!id || !(await store.exists(id))) return send(res, 404, { error: "not_found", message: "이미 지워진 일정이에요." });
      const body = await readBody(req);
      const ev = clean(body);
      if (!ev) return send(res, 400, { error: "invalid", message: "일정 내용이 올바르지 않아요." });
      await store.put(id, { ...ev, createdAt: Number(body.createdAt) || Date.now(), updatedAt: Date.now() });
      return send(res, 200, { id });
    }

    if (req.method === "DELETE") {
      if (!id) return send(res, 400, { error: "invalid", message: "지울 일정을 찾지 못했어요." });
      await store.del(id);
      return send(res, 200, { id });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return send(res, 405, { error: "method" });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: "server", message: "서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요." });
  }
}
