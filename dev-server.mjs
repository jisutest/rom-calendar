// 로컬 확인용 서버: index.html과 /api/events를 Vercel처럼 띄운다.
// 저장은 메모리에만 되고, 비밀번호는 FAMILY_PASSWORD (기본값 "romi").
//   npm run dev  →  http://localhost:5178
import http from "node:http";
import { readFile } from "node:fs/promises";

process.env.FAMILY_PASSWORD ||= "romi";
const { default: events } = await import("./api/events.js");
const PORT = Number(process.env.PORT) || 5178;

http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/events")) return events(req, res);
  if (req.url === "/" || req.url.startsWith("/?") || req.url === "/index.html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(await readFile(new URL("./index.html", import.meta.url)));
  }
  res.statusCode = 404; res.end("not found");
}).listen(PORT, () => console.log(`롬캘린더 → http://localhost:${PORT}  (비밀번호: ${process.env.FAMILY_PASSWORD})`));
