// POST /api/midia/publicar: publica um rascunho. body: { id, confirmar: true }
// Lógica e regras em api/_lib/rotas-midia.js.
import { rotaPublicar } from "../_lib/rotas-midia.js";

export default function handler(req, res) {
  return rotaPublicar(req, res);
}
