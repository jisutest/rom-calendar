// 로컬 확인용 서버: index.html과 /api/events를 Vercel처럼 띄운다.
// 저장은 메모리에만 되고, 비밀번호는 FAMILY_PASSWORD (기본값 "romi").
//   npm run dev  →  http://localhost:5178
import http from "node:http";
import { readFile } from "node:fs/promises";

process.env.FAMILY_PASSWORD ||= "romi";
const routes = {
  "/api/events": (await import("./api/events.js")).default,
  "/api/fixed": (await import("./api/fixed.js")).default,
  "/api/expenses": (await import("./api/expenses.js")).default,
  "/api/assets": (await import("./api/assets.js")).default,
  "/api/health": (await import("./api/health.js")).default,
};
const PORT = Number(process.env.PORT) || 5178;

http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  if (routes[path]) return routes[path](req, res);
  if (req.url === "/" || req.url.startsWith("/?") || req.url === "/index.html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(await readFile(new URL("./index.html", import.meta.url)));
  }
  const file = path.match(/^\/(fonts|img)\/([\w.-]+\.(ttf|woff2?|png))$/);
  if (file) {
    try {
      res.setHeader("Content-Type", { ttf: "font/ttf", woff: "font/woff", woff2: "font/woff2", png: "image/png" }[file[3]]);
      return res.end(await readFile(new URL(`./${file[1]}/${file[2]}`, import.meta.url)));
    } catch {}
  }
  res.statusCode = 404; res.end("not found");
}).listen(PORT, () => console.log(`롬데이즈 → http://localhost:${PORT}  (비밀번호: ${process.env.FAMILY_PASSWORD})`));
