// 가족 일정: GET/POST /api/events, PUT/DELETE /api/events?id=...
import { makeHandler, cleanEvent } from "./_store.js";

export default makeHandler({ key: "rom:events", clean: cleanEvent, max: 5000, listName: "events" });
