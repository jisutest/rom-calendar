// 변동 지출: GET/POST /api/expenses, PUT/DELETE /api/expenses?id=...
import { makeHandler, cleanExpense } from "./_store.js";

export default makeHandler({ key: "rom:expenses", clean: cleanExpense, max: 20000, listName: "expenses" });
