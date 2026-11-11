// 저장소 연결 상태: GET /api/health (비밀번호 필요 없음, 비밀 값은 보내지 않음)
import { storageStatus, send } from "./_store.js";

export default async function handler(req, res) {
  return send(res, 200, await storageStatus());
}
