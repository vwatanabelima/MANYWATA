// Peças de segurança da rota de publicação (api/midia/*, api/carrossel/*).
//
// Mora em api/_lib/: na Vercel, arquivo ou pasta com prefixo "_" dentro de
// api/ NÃO vira rota. Então nada aqui é acessível de fora.
//
// O que tem aqui:
//   - ErroHttp: erro com status HTTP, que a rota devolve como está
//   - exigirSegredo / autenticar: PUBLICAR_SECRET + Authorization: Bearer
//   - sanitizar: tira access_token / Bearer / segredos de qualquer texto
//   - validarUrlPublica: só https, sem localhost nem IP privado

import crypto from "node:crypto";

// O PUBLICAR_SECRET é a única coisa entre a internet e um post no perfil.
// Segredo curto = adivinhável. Gere com: openssl rand -hex 32
export const TAMANHO_MIN_SEGREDO = 32;

export class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.name = "ErroHttp";
    this.status = status;
  }
}

// ── Segredo e autenticação ────────────────────────────────────────────────

// Sem segredo (ou com segredo fraco) a publicação fica DESLIGADA: 503 antes de
// qualquer fetch.
export function exigirSegredo(env = process.env) {
  const segredo = env.PUBLICAR_SECRET;
  if (!segredo) {
    throw new ErroHttp(503, "PUBLICAR_SECRET não está configurado no servidor: publicação desligada.");
  }
  if (segredo.length < TAMANHO_MIN_SEGREDO) {
    throw new ErroHttp(
      503,
      `PUBLICAR_SECRET curto demais (mínimo ${TAMANHO_MIN_SEGREDO} caracteres): publicação desligada. Gere com: openssl rand -hex 32`
    );
  }
  return segredo;
}

// Compara em tempo constante. O hash antes iguala os tamanhos, assim
// timingSafeEqual não estoura e o tamanho do segredo não vaza pelo tempo.
function iguaisSeguro(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function bearerDoHeader(req) {
  const header = req.headers?.authorization;
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(String(header));
  return m ? m[1].trim() : "";
}

// Exige "Authorization: Bearer <PUBLICAR_SECRET>".
export function autenticar(req, env = process.env) {
  const segredo = exigirSegredo(env);
  const recebido = bearerDoHeader(req);
  if (!recebido || !iguaisSeguro(recebido, segredo)) {
    throw new ErroHttp(401, "não autorizado: mande o header Authorization: Bearer <PUBLICAR_SECRET>.");
  }
}

// ── Sanitização ───────────────────────────────────────────────────────────

// Tira token de qualquer texto que vá pra resposta ou pro log. Os segredos
// conhecidos (token da conta, PUBLICAR_SECRET) são trocados literalmente, e
// access_token=... / Bearer ... por padrão, caso venha um que a gente não
// conhece (ex.: uma URL ecoada pelo Graph numa mensagem de erro).
export function sanitizar(texto, segredos = []) {
  let s = String(texto ?? "");
  for (const segredo of segredos) {
    if (segredo && segredo.length >= 8) s = s.split(segredo).join("[oculto]");
  }
  return s
    .replace(/access_token=[^&\s"'<>]+/gi, "access_token=[oculto]")
    .replace(/Bearer\s+[^\s"',]+/gi, "Bearer [oculto]");
}

// ── URLs públicas ─────────────────────────────────────────────────────────

// Quem baixa a mídia é o servidor do Meta, então a URL precisa ser pública
// de verdade. Isto pega engano (localhost, rede interna, http) antes de gastar
// uma chamada no Graph.
export function validarUrlPublica(valor, rotulo = "url") {
  let u;
  try {
    u = new URL(String(valor ?? ""));
  } catch {
    throw new ErroHttp(400, `${rotulo}: URL inválida.`);
  }
  if (u.protocol !== "https:") {
    throw new ErroHttp(400, `${rotulo}: só https é aceito (veio ${u.protocol.replace(":", "")}).`);
  }
  if (u.username || u.password) {
    throw new ErroHttp(400, `${rotulo}: URL não pode ter usuário/senha.`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostNaoPublico(host)) {
    throw new ErroHttp(400, `${rotulo}: host "${host}" não é público (localhost, rede interna ou IP privado).`);
  }
  return u.href;
}

function hostNaoPublico(host) {
  if (!host) return true;
  if (host === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return true;

  // O parser de URL já normaliza IPv4 escrito de jeito estranho
  // (2130706433, 0x7f.1, ...) pra forma a.b.c.d.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) ||           // link-local / metadata de nuvem
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224                              // multicast / reservado
    );
  }

  if (host.includes(":")) {
    // IPv6 literal: loopback, não especificado, ULA (fc00::/7),
    // link-local (fe80::/10) e IPv4 mapeado (::ffff:...) ficam de fora.
    return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:");
  }

  // Nome sem ponto (ex.: "intranet") não é domínio público.
  return !host.includes(".");
}
