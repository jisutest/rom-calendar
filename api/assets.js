// 자산: GET/POST /api/assets, PUT/DELETE /api/assets?id=...
import { makeHandler, cleanAsset } from "./_store.js";

export default makeHandler({ key: "rom:assets", clean: cleanAsset, max: 500, listName: "assets" });
