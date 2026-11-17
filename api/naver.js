// 네이버 캘린더 가져오기 (보기 전용): GET /api/naver — 가족 비밀번호 필요
// 네이버 쪽 일정은 바꾸지 않고, 고른 캘린더의 일정만 읽어서 보여 준다.
//
// 설정 (Vercel 환경 변수, 둘 중 하나):
//  1) CalDAV:  NAVER_ID, NAVER_APP_PASSWORD (네이버에서 만든 '애플리케이션 비밀번호'),
//              NAVER_CALENDARS = 보여 줄 캘린더 이름 (여러 개면 쉼표로). 비워 두면 캘린더 목록만 알려 준다.
//  2) iCal 주소: NAVER_ICS_URL = 캘린더 구독(.ics) 주소 (여러 개면 쉼표나 줄바꿈으로)
//  공통(선택): NAVER_KEYWORD = 제목에 이 글자가 있는 일정만 (예: [롬]). 여러 개면 쉼표로.
// 반복 일정은 여기서 날짜별로 펼쳐서 보낸다 (지금부터 약 4달 전 ~ 1년 반 뒤).
import { checkAuth, send } from "./_store.js";

const env = k => String(process.env[k] || "").trim();
const list = s => s.split(/[,\n]/).map(x => x.trim()).filter(Boolean);
const DAY = 86400000;
const KST = 9 * 3600000;
const pad = n => String(n).padStart(2, "0");
const ymd = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const hm = ms => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const MAX_EVENTS = 3000;
const CACHE_MS = 3 * 60000;
let cache = null; // { at, key, data }

export default async function handler(req, res) {
  try {
    if (!(await checkAuth(req, res))) return;
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return send(res, 405, { error: "method" }); }
    const fresh = new URL(req.url, "http://x").searchParams.get("fresh") === "1";
    const key = ["NAVER_ID", "NAVER_APP_PASSWORD", "NAVER_CALENDARS", "NAVER_ICS_URL", "NAVER_KEYWORD", "NAVER_CALDAV_URL"].map(env).join("\u0001");
    if (!fresh && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return send(res, 200, cache.data);
    const data = await loadAll();
    if (!data.error) cache = { at: Date.now(), key, data };
    return send(res, 200, data);
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: "server", message: "서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요." });
  }
}

async function loadAll() {
  const icsUrls = list(env("NAVER_ICS_URL"));
  const id = env("NAVER_ID"), pw = env("NAVER_APP_PASSWORD");
  const useDav = !!(id && pw);
  if (!useDav && !icsUrls.length) return { configured: false, events: [], calendars: [] };

  const now = Date.now() + KST;
  const win = { from: Math.floor(now / DAY) * DAY - 120 * DAY, to: Math.floor(now / DAY) * DAY + 550 * DAY };
  const keywords = list(env("NAVER_KEYWORD"));
  const out = { configured: true, mode: useDav ? "caldav" : "ics", calendars: [], picked: [], keyword: keywords.join(", "), events: [], fetchedAt: Date.now() };
  const blocks = []; // { cal, ics }

  try {
    if (useDav) {
      const wanted = list(env("NAVER_CALENDARS"));
      const cals = await davCalendars(env("NAVER_CALDAV_URL") || "https://caldav.calendar.naver.com/", id, pw);
      out.calendars = cals.map(c => c.name);
      const norm = s => s.replace(/\s+/g, "").toLowerCase();
      const chosen = cals.filter(c => wanted.some(w => norm(w) === norm(c.name)));
      out.picked = chosen.map(c => c.name);
      if (!wanted.length) out.needPick = true;
      else if (!chosen.length) out.error = `NAVER_CALENDARS에 적은 캘린더(${wanted.join(", ")})를 찾지 못했어요. 아래 목록의 이름과 똑같이 적어 주세요.`;
      out.diag = [];
      for (const c of chosen) {
        const { ics, diag } = await davEvents(c.url, id, pw, win);
        out.diag.push({ cal: c.name, steps: diag.steps });
        for (const x of ics) blocks.push({ cal: c.name, ics: x });
      }
    } else {
      for (const u of icsUrls) {
        const r = await fetch(u.replace(/^webcal:/i, "https:"), { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw Object.assign(new Error(`ics ${r.status}`), { http: r.status });
        const ics = await r.text();
        const name = unescText((ics.match(/^X-WR-CALNAME:(.*)$/m) || [])[1] || "").trim() || "네이버";
        out.calendars.push(name); out.picked.push(name);
        blocks.push({ cal: name, ics });
      }
    }
  } catch (e) {
    console.error("naver", e);
    out.error = e.http === 401 || e.http === 403
      ? "네이버 아이디나 애플리케이션 비밀번호가 맞지 않아요."
      : "네이버 캘린더에서 일정을 받아오지 못했어요. 잠시 후 다시 시도해 주세요.";
    return out;
  }

  // 같은 UID를 한 번에 펼치기 위해 모든 블록의 VEVENT를 모은다
  const byUid = new Map();
  const stat = { vevents: 0, noDate: 0, samples: [] };
  for (const b of blocks) for (const ev of parseIcs(b.ics, stat)) {
    ev.cal = b.cal;
    const k = b.cal + "\u0001" + ev.uid;
    if (!byUid.has(k)) byUid.set(k, []);
    byUid.get(k).push(ev);
  }
  const events = [];
  for (const group of byUid.values()) {
    const masters = group.filter(e => !e.recurId);
    const overrides = group.filter(e => e.recurId);
    for (const m of masters) {
      for (const o of overrides) m.exdates.add(o.recurId.date);
      events.push(...expandEvent(m, win));
    }
    for (const o of overrides) events.push(...expandEvent({ ...o, rrule: null }, win));
  }
  const kept = keywords.length
    ? events.filter(e => keywords.some(k => e.title.includes(k))).map(e => ({ ...e, title: keywords.reduce((t, k) => t.split(k).join(" "), e.title).replace(/\s+/g, " ").trim() || e.title }))
    : events;
  kept.sort((a, b) => a.start.localeCompare(b.start) || (a.time || "").localeCompare(b.time || ""));
  out.events = kept.slice(0, MAX_EVENTS);
  out.stat = { blocks: blocks.length, vevents: stat.vevents, noDate: stat.noDate, samples: stat.samples, inWindow: events.length, kept: kept.length };
  return out;
}

// ---------------- CalDAV ----------------
async function dav(method, url, user, pw, depth, body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: "Basic " + Buffer.from(`${user}:${pw}`).toString("base64"), Depth: String(depth), "Content-Type": "application/xml; charset=utf-8" },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok && r.status !== 207) throw Object.assign(new Error(`caldav ${method} ${r.status}`), { http: r.status });
  return { xml: await r.text(), url: r.url || url };
}
const PROP = inner => `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${inner}</d:prop></d:propfind>`;
const tagRe = name => new RegExp(`<(?:[\\w-]+:)?${name}(?=[\\s/>])[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`, "gi");
const tags = (xml, name) => [...String(xml || "").matchAll(tagRe(name))].map(m => m[1] || "");
const tag = (xml, name) => tags(xml, name)[0];
function xmlText(s) {
  s = String(s || "");
  const cdata = [...s.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)];
  if (cdata.length) return cdata.map(m => m[1]).join("");
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");
}

async function davCalendars(base, user, pw) {
  // 1) 내 principal → 2) 캘린더 홈 → 3) 홈 아래 캘린더 목록
  let principal = base;
  for (const start of [base, new URL("/.well-known/caldav", base).href]) {
    try {
      const r = await dav("PROPFIND", start, user, pw, 0, PROP("<d:current-user-principal/>"));
      const href = xmlText(tag(tag(r.xml, "current-user-principal"), "href") || "").trim();
      if (href) { principal = new URL(href, r.url).href; break; }
    } catch (e) { if (e.http === 401 || e.http === 403) throw e; }
  }
  let home = principal;
  const r2 = await dav("PROPFIND", principal, user, pw, 0, PROP("<c:calendar-home-set/>"));
  const homeHref = xmlText(tag(tag(r2.xml, "calendar-home-set"), "href") || "").trim();
  if (homeHref) home = new URL(homeHref, r2.url).href;
  const r3 = await dav("PROPFIND", home, user, pw, 1, PROP("<d:displayname/><d:resourcetype/>"));
  const cals = [];
  for (const resp of tags(r3.xml, "response")) {
    const rt = tag(resp, "resourcetype") || "";
    if (!/<(?:[\w-]+:)?calendar(?=[\s/>])/i.test(rt)) continue;
    const href = xmlText(tag(resp, "href") || "").trim();
    if (!href) continue;
    const url = new URL(href, r3.url).href;
    const name = xmlText(tag(resp, "displayname") || "").trim() || decodeURIComponent(href.replace(/\/$/, "").split("/").pop());
    cals.push({ name, url });
  }
  return cals;
}

async function davEvents(url, user, pw, win) {
  const z = ms => new Date(ms - KST).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">`
    + `<d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">`
    + `<c:time-range start="${z(win.from)}" end="${z(win.to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const diag = { steps: [] };
  const read = xml => {
    const resps = tags(xml, "response");
    const hrefs = [], ics = [];
    for (const resp of resps) {
      const href = xmlText(tag(resp, "href") || "").trim();
      const data = xmlText(tag(resp, "calendar-data") || "");
      if (data.includes("BEGIN:VEVENT")) ics.push(data);
      else if (href && !/\/$/.test(href)) hrefs.push(href);
    }
    return { n: resps.length, hrefs, ics };
  };
  const step = (name, x, extra) => diag.steps.push(`${name}: 응답 ${x.n}개 · 일정 데이터 ${x.ics.length}개` + (extra || ""));

  // 1) 기간을 정해서 일정 데이터 요청
  let got = { n: 0, hrefs: [], ics: [] };
  try { got = read((await dav("REPORT", url, user, pw, 1, body)).xml); step("기간 조회", got); }
  catch (e) { if (e.http === 401 || e.http === 403) throw e; diag.steps.push(`기간 조회: 실패(${e.http || e.message})`); }

  // 2) 아무것도 없으면 기간 조건 없이 다시
  if (!got.ics.length && !got.hrefs.length) {
    const all = body.replace(/<c:time-range[^>]*\/>/, "");
    try { got = read((await dav("REPORT", url, user, pw, 1, all)).xml); step("전체 조회", got); }
    catch (e) { if (e.http === 401 || e.http === 403) throw e; diag.steps.push(`전체 조회: 실패(${e.http || e.message})`); }
  }
  // 3) 주소만 오고 내용이 없으면 주소로 한꺼번에(multiget), 그래도 없으면 하나씩 받기
  if (!got.ics.length && !got.hrefs.length) {
    try {
      const r = await dav("PROPFIND", url, user, pw, 1, PROP("<d:getetag/><d:getcontenttype/>"));
      const x = read(r.xml);
      got.hrefs = x.hrefs; step("목록 조회", x, ` · 파일 ${x.hrefs.length}개`);
    } catch (e) { if (e.http === 401 || e.http === 403) throw e; diag.steps.push(`목록 조회: 실패(${e.http || e.message})`); }
  }
  if (!got.ics.length && got.hrefs.length) {
    const hrefs = got.hrefs.slice(0, 500);
    for (let i = 0; i < hrefs.length; i += 100) {
      const mg = `<?xml version="1.0" encoding="utf-8"?><c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop>`
        + hrefs.slice(i, i + 100).map(h => `<d:href>${h.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</d:href>`).join("") + `</c:calendar-multiget>`;
      try { const x = read((await dav("REPORT", url, user, pw, 1, mg)).xml); got.ics.push(...x.ics); step("묶음 받기", x); }
      catch (e) { if (e.http === 401 || e.http === 403) throw e; diag.steps.push(`묶음 받기: 실패(${e.http || e.message})`); break; }
    }
    if (!got.ics.length) {
      let ok = 0;
      for (const h of hrefs.slice(0, 200)) {
        try {
          const r = await fetch(new URL(h, url).href, { headers: { Authorization: "Basic " + Buffer.from(`${user}:${pw}`).toString("base64") }, signal: AbortSignal.timeout(8000) });
          const t = r.ok ? await r.text() : "";
          if (t.includes("BEGIN:VEVENT")) { got.ics.push(t); ok++; }
        } catch {}
      }
      diag.steps.push(`하나씩 받기: ${ok}개`);
    }
  }
  diag.ics = got.ics.length;
  return { ics: got.ics, diag };
}

// ---------------- iCalendar 읽기 ----------------
const unescText = s => String(s).replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

// 날짜 값 → 한국 시간 기준 '벽시계' ms (UTC 필드에 담음)
function parseDate(value, params) {
  const v = String(value || "").trim();
  let m = v.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (m || String(params.VALUE || "").toUpperCase() === "DATE") {
    m = m || v.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
    if (!m) return null;
    return { ms: Date.UTC(+m[1], +m[2] - 1, +m[3]), allDay: true, date: `${m[1]}-${m[2]}-${m[3]}` };
  }
  // 보통은 20261117T100000(Z), 가끔 초가 없거나 - : 가 섞인 형태도 받아 준다
  m = v.match(/^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2})(?::?(\d{2}))?(?:\.\d+)?(Z?)$/i);
  if (!m) return null;
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (m[7]) ms += KST; // UTC → 한국 시간 (TZID가 있으면 그 지역 시간 그대로 둔다)
  return { ms, allDay: false, date: ymd(ms) };
}

function parseIcs(text, stat) {
  const lines = String(text).replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out = [];
  const stack = [];
  let cur = null;
  for (const line of lines) {
    if (!line) continue;
    let i = -1;
    for (let q = false, j = 0; j < line.length; j++) {
      if (line[j] === '"') q = !q;
      else if (line[j] === ":" && !q) { i = j; break; }
    }
    if (i < 0) continue;
    const head = line.slice(0, i), value = line.slice(i + 1);
    const [nameRaw, ...ps] = head.split(";");
    const name = nameRaw.toUpperCase();
    const params = {};
    for (const p of ps) { const j = p.indexOf("="); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, ""); }
    if (name === "BEGIN") {
      stack.push(value.toUpperCase());
      if (value.toUpperCase() === "VEVENT") cur = { uid: "", title: "", memo: "", loc: "", start: null, end: null, dur: null, rrule: null, exdates: new Set(), recurId: null, cancelled: false };
      continue;
    }
    if (name === "END") {
      const top = stack.pop();
      if (top === "VEVENT" && cur) {
        if (stat) { stat.vevents++; if (!cur.start) { stat.noDate++; if (stat.samples.length < 3) stat.samples.push(cur.rawStart || "(DTSTART 없음)"); } }
        if (cur.start && !cur.cancelled) out.push(cur);
        cur = null;
      }
      continue;
    }
    if (!cur || stack[stack.length - 1] !== "VEVENT") continue;
    switch (name) {
      case "UID": cur.uid = value; break;
      case "SUMMARY": cur.title = unescText(value).trim().slice(0, 80); break;
      case "DESCRIPTION": cur.memo = unescText(value).trim().slice(0, 500); break;
      case "LOCATION": cur.loc = unescText(value).trim().slice(0, 100); break;
      case "DTSTART": cur.start = parseDate(value, params); cur.rawStart = (head + ":" + value).slice(0, 80); break;
      case "DTEND": cur.end = parseDate(value, params); break;
      case "DURATION": cur.dur = parseDuration(value); break;
      case "RRULE": cur.rrule = value; break;
      case "EXDATE": for (const v of value.split(",")) { const d = parseDate(v, params); if (d) cur.exdates.add(d.date); } break;
      case "RECURRENCE-ID": cur.recurId = parseDate(value, params); break;
      case "STATUS": if (value.toUpperCase() === "CANCELLED") cur.cancelled = true; break;
    }
  }
  return out;
}

function parseDuration(v) {
  const m = String(v).match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 * DAY) + ((+m[3] || 0) * DAY) + ((+m[4] || 0) * 3600000) + ((+m[5] || 0) * 60000) + ((+m[6] || 0) * 1000);
  return m[1] === "-" ? -ms : ms;
}

// ---------------- 반복 일정 펼치기 ----------------
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const dim = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // m: 0~11

function parseRule(s) {
  const r = {};
  for (const part of String(s).split(";")) { const [k, v] = part.split("="); if (k && v) r[k.toUpperCase()] = v; }
  return {
    freq: r.FREQ, interval: Math.max(1, +r.INTERVAL || 1), count: r.COUNT ? +r.COUNT : Infinity,
    until: r.UNTIL ? parseDate(r.UNTIL, {}) : null,
    byday: r.BYDAY ? r.BYDAY.split(",").map(x => { const m = x.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i); return m ? { n: m[1] ? +m[1] : 0, wd: WD[m[2].toUpperCase()] } : null; }).filter(Boolean) : [],
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number).filter(n => n && Math.abs(n) <= 31) : [],
    bymonth: r.BYMONTH ? r.BYMONTH.split(",").map(Number).filter(n => n >= 1 && n <= 12) : [],
  };
}

// 한 달(y, m) 안에서 규칙에 맞는 날짜들 (일 번호)
function daysInMonthFor(rule, y, m, startDay) {
  const n = dim(y, m);
  const days = new Set();
  if (rule.byday.length) {
    for (const { n: nth, wd } of rule.byday) {
      const all = [];
      for (let d = 1; d <= n; d++) if (new Date(Date.UTC(y, m, d)).getUTCDay() === wd) all.push(d);
      if (!nth) all.forEach(d => days.add(d));
      else { const d = nth > 0 ? all[nth - 1] : all[all.length + nth]; if (d) days.add(d); }
    }
  } else if (rule.bymonthday.length) {
    for (const md of rule.bymonthday) { const d = md > 0 ? md : n + md + 1; if (d >= 1 && d <= n) days.add(d); }
  } else if (startDay <= n) days.add(startDay);
  return [...days].sort((a, b) => a - b);
}

function* occurrences(ev) {
  const s = ev.start.ms;
  if (!ev.rrule) { yield s; return; }
  const rule = parseRule(ev.rrule);
  const tod = s - Math.floor(s / DAY) * DAY; // 하루 중 시각
  const sd = new Date(s);
  const sy = sd.getUTCFullYear(), sm = sd.getUTCMonth(), sdd = sd.getUTCDate();
  for (let step = 0, guard = 0; guard < 60000; step++) {
    let cands = [];
    if (rule.freq === "DAILY") cands = [s + step * rule.interval * DAY];
    else if (rule.freq === "WEEKLY") {
      const wkStart = Math.floor(s / DAY) * DAY - ((sd.getUTCDay() + 6) % 7) * DAY + step * rule.interval * 7 * DAY; // 월요일 시작
      const wds = rule.byday.length ? rule.byday.map(b => b.wd) : [sd.getUTCDay()];
      cands = [...new Set(wds)].map(wd => wkStart + ((wd + 6) % 7) * DAY + tod).sort((a, b) => a - b);
    } else if (rule.freq === "MONTHLY") {
      const t = sm + step * rule.interval, y = sy + Math.floor(t / 12), m = t % 12;
      cands = daysInMonthFor(rule, y, m, sdd).map(d => Date.UTC(y, m, d) + tod);
    } else if (rule.freq === "YEARLY") {
      const y = sy + step * rule.interval;
      const months = rule.bymonth.length ? rule.bymonth.map(x => x - 1) : [sm];
      for (const m of months.sort((a, b) => a - b)) cands.push(...daysInMonthFor(rule, y, m, sdd).map(d => Date.UTC(y, m, d) + tod));
    } else { yield s; return; }
    for (const c of cands) {
      guard++;
      if (c < s) continue;
      if (rule.until && (rule.until.allDay ? ymd(c) > rule.until.date : c > rule.until.ms)) return;
      if (rule.count-- <= 0) return;
      yield c;
    }
    if (step > 40000) return;
    if (cands.length && cands[0] > s + 30 * 365 * DAY) return;
  }
}

function expandEvent(ev, win) {
  const s = ev.start;
  let dur;
  if (ev.end && ev.end.ms > s.ms) dur = ev.end.ms - s.ms;
  else if (ev.dur != null && ev.dur > 0) dur = ev.dur;
  else dur = s.allDay ? DAY : 0;
  const out = [];
  for (const o of occurrences(ev)) {
    if (o > win.to) break;
    const endMs = o + dur;
    if (endMs < win.from) continue;
    const date = ymd(o);
    if (ev.rrule && ev.exdates.has(date)) continue;
    // 끝 날짜: 하루 종일이면 끝(다음날 0시) 전날, 시간 일정이 자정에 끝나면 그 전날
    const lastMs = s.allDay || (dur > 0 && endMs % DAY === 0) ? endMs - 1 : endMs;
    const end = ymd(Math.max(o, lastMs));
    out.push({
      id: `${ev.uid || ev.title}@${date}`.slice(0, 200),
      title: ev.title || "(제목 없음)", start: date, end,
      time: s.allDay ? "" : hm(o), endTime: s.allDay || !dur ? "" : hm(endMs),
      cal: ev.cal, memo: ev.memo, loc: ev.loc,
    });
    if (out.length > 1000) break;
  }
  return out;
}

// 테스트용으로 내보낸다 (화면에서는 쓰지 않음)
export const _test = { parseIcs, expandEvent };
