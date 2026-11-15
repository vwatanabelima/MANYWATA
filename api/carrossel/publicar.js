// Alias de /api/midia/publicar que só aceita rascunho de CAROUSEL.
import { rotaPublicar } from "../_lib/rotas-midia.js";

export default function handler(req, res) {
  return rotaPublicar(req, res, { tipoFixo: "CAROUSEL" });
}
