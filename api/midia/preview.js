// GET /api/midia/preview?id=...: página com slides + legenda, só leitura.
// Por que o id assinado basta pra abrir: ver comentário em api/_lib/rotas-midia.js.
import { rotaPreview } from "../_lib/rotas-midia.js";

export default function handler(req, res) {
  return rotaPreview(req, res);
}
