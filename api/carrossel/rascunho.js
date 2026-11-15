// Alias de /api/midia/rascunho com tipo fixo CAROUSEL (o campo "tipo" pode
// ser omitido; se vier diferente, 400).
import { rotaRascunho } from "../_lib/rotas-midia.js";

export default function handler(req, res) {
  return rotaRascunho(req, res, { tipoFixo: "CAROUSEL" });
}
