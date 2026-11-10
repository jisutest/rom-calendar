// 고정비: GET/POST /api/fixed, PUT/DELETE /api/fixed?id=...
import { makeHandler, cleanFixed } from "./_store.js";

export default makeHandler({ key: "rom:fixed", clean: cleanFixed, max: 300, listName: "fixed" });
