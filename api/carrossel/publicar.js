// Alias de /api/midia/publicar com tipo fixo CAROUSEL (o campo "tipo" pode
// ser omitido; se vier diferente, 400).
import { rotaPublicar } from "../_lib/rotas-midia.js";

export default function handler(req, res) {
  return rotaPublicar(req, res, { tipoFixo: "CAROUSEL" });
}
