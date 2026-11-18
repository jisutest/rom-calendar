// 롬데이즈 서비스 워커: 홈 화면 앱이 빨리 열리고, 인터넷이 끊겨도 화면은 뜨게 한다.
// - 화면(index.html): 인터넷이 되면 항상 새로 받고(최신 유지), 안 되면 저장해 둔 것을 보여 준다.
// - 글꼴·그림: 한 번 받으면 저장해 두고 쓴다.
// - /api (가족 일정·가계부·자산): 개인 정보라 절대 저장하지 않는다.
const VERSION = "romdays-v2";
const SHELL = ["/", "/manifest.webmanifest", "/img/romi-face.png", "/img/icon-192.png", "/img/favicon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return; // 기본 동작 (저장 안 함)

  // 화면: 네트워크 먼저, 실패하면 저장본
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put("/", copy)); }
      return res;
    }).catch(() => caches.match("/")));
    return;
  }

  // 글꼴·그림·manifest: 저장본 먼저, 없으면 받아서 저장
  if (/^\/(fonts|img)\//.test(url.pathname) || url.pathname === "/manifest.webmanifest") {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    })));
  }
});
