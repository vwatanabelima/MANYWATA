// POST /api/midia/publicar: valida, cria os containers e publica numa chamada.
// body: { conta: "eterniza", tipo: "CAROUSEL", itens: [{ url }], legenda, confirmar: true }
// Lógica e regras em api/_lib/rotas-midia.js.
import { rotaPublicar } from "../_lib/rotas-midia.js";

export default function handler(req, res) {
  return rotaPublicar(req, res);
}
