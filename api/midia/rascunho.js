// POST /api/midia/rascunho: cria o container no Instagram SEM publicar.
// body: { conta: "eterniza", tipo: "CAROUSEL", itens: [{ url }], legenda }
// Lógica e regras em api/_lib/rotas-midia.js.
import { rotaRascunho } from "../_lib/rotas-midia.js";

export default function handler(req, res) {
  return rotaRascunho(req, res);
}
