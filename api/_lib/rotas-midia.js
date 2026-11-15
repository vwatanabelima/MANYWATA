// Lógica das rotas de publicação. Os arquivos em api/midia/ e api/carrossel/
// só chamam estas funções (aliases ficam com 3 linhas).
//
//   POST /api/midia/rascunho   cria o container no Instagram, NÃO publica
//   POST /api/midia/publicar   publica um rascunho, só com confirmar: true
//   GET  /api/midia/preview    página HTML com slides + legenda, só leitura
//
// Cada função recebe (req, res, opcoes). Em produção opcoes vem vazio e cai
// em process.env / fetch global / relógio de verdade; os testes injetam tudo.
//
// Nunca entra token em resposta ou log: todo erro passa por sanitizar() com
// o token da conta e o PUBLICAR_SECRET na lista do que esconder.

import { contaPorSlug, tokenDaConta } from "../contas.js";
import {
  ErroHttp,
  autenticar,
  bearerDoHeader,
  exigirSegredo,
  iguaisSeguro,
  assinarRascunho,
  lerRascunho,
  sanitizar,
  escaparHtml,
  VALIDADE_RASCUNHO_MS,
} from "./seguranca.js";
import { criarPublicador, tipoDefinido } from "./instagram-publicacao.js";

// A função da Vercel tem ~60s (vercel.json). Deixa margem pra responder.
const ORCAMENTO_RASCUNHO_MS = 50_000;
const ORCAMENTO_CHECAGEM_PUBLICAR_MS = 15_000;

function contexto(opcoes = {}) {
  const env = opcoes.env || process.env;
  return {
    env,
    fetch: opcoes.fetch || globalThis.fetch,
    sleep: opcoes.sleep,
    now: opcoes.now || Date.now,
    intervaloMs: opcoes.intervaloMs,
    orcamentoMs: opcoes.orcamentoMs ?? ORCAMENTO_RASCUNHO_MS,
    tipoFixo: opcoes.tipoFixo,
    // tudo que nunca pode sair numa resposta/log; o token entra depois
    segredos: [env.PUBLICAR_SECRET].filter(Boolean),
  };
}

// Erro esperado (ErroHttp) volta com o status dele. Inesperado vira 500
// genérico e o detalhe (sanitizado) vai só pro log.
async function tratar(res, ctx, fn, { html = false } = {}) {
  try {
    return await fn();
  } catch (e) {
    const esperado = e instanceof ErroHttp;
    const status = esperado ? e.status : 500;
    const mensagem = esperado ? sanitizar(e.message, ctx.segredos) : "erro interno; veja o log da função.";
    if (!esperado) console.error("midia: erro inesperado:", sanitizar(e?.stack || e?.message || e, ctx.segredos));
    if (html) {
      cabecalhosPreview(res);
      return res.status(status).send(paginaErro(status, mensagem));
    }
    return res.status(status).json({ erro: mensagem });
  }
}

function exigirMetodo(req, res, metodo) {
  if (req.method !== metodo) {
    res.setHeader("Allow", metodo);
    throw new ErroHttp(405, `método ${req.method} não permitido; use ${metodo}.`);
  }
}

function lerCorpo(req) {
  let corpo;
  try {
    corpo = req.body; // o getter da Vercel pode lançar com JSON inválido
  } catch {
    throw new ErroHttp(400, "corpo não é JSON válido.");
  }
  if (Buffer.isBuffer(corpo)) corpo = corpo.toString("utf8");
  if (typeof corpo === "string") {
    try {
      corpo = JSON.parse(corpo);
    } catch {
      throw new ErroHttp(400, "corpo não é JSON válido.");
    }
  }
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) {
    throw new ErroHttp(400, "corpo precisa ser um objeto JSON.");
  }
  return corpo;
}

function contaObrigatoria(slug) {
  const conta = typeof slug === "string" ? contaPorSlug(slug) : undefined;
  if (!conta) throw new ErroHttp(400, `conta "${slug ?? ""}" não existe em api/contas.js.`);
  return conta;
}

function tokenObrigatorio(conta, ctx) {
  const token = tokenDaConta(conta, ctx.env);
  if (!token) {
    throw new ErroHttp(503, `${conta.tokenEnv} não está configurado neste ambiente (hoje ele só existe em production).`);
  }
  ctx.segredos.push(token);
  return token;
}

function publicadorDa(conta, token, ctx) {
  return criarPublicador({
    userId: conta.userId,
    token,
    fetch: ctx.fetch,
    sleep: ctx.sleep,
    now: ctx.now,
    intervaloMs: ctx.intervaloMs,
  });
}

function urlPreview(req, id) {
  const caminho = `/api/midia/preview?id=${encodeURIComponent(id)}`;
  const host = req.headers?.["x-forwarded-host"] || req.headers?.host;
  if (!host) return caminho;
  const proto = req.headers?.["x-forwarded-proto"] || "https";
  return `${proto}://${host}${caminho}`;
}

// ── POST /api/midia/rascunho ──────────────────────────────────────────────
// body: { conta: "eterniza", tipo: "CAROUSEL", itens: [{ url }], legenda }
// No alias /api/carrossel/rascunho o tipo é fixo (CAROUSEL) e pode ser omitido.

export async function rotaRascunho(req, res, opcoes = {}) {
  const ctx = contexto(opcoes);
  return tratar(res, ctx, async () => {
    exigirMetodo(req, res, "POST");
    const segredo = autenticar(req, ctx.env);
    const corpo = lerCorpo(req);

    const tipoPedido = corpo.tipo ?? ctx.tipoFixo;
    if (ctx.tipoFixo && String(tipoPedido).toUpperCase() !== ctx.tipoFixo) {
      throw new ErroHttp(400, `esta rota só aceita tipo ${ctx.tipoFixo}; use /api/midia/rascunho.`);
    }
    const { nome: tipo, def } = tipoDefinido(tipoPedido);
    const conta = contaObrigatoria(corpo.conta);
    const dados = def.validar(corpo);
    const token = tokenObrigatorio(conta, ctx);

    // criadoEm ANTES de criar o container: a validade de 24h conta a partir
    // dele, então o rascunho expira um pouco antes do container, nunca depois.
    const criadoEm = ctx.now();
    const prazo = criadoEm + ctx.orcamentoMs;
    const pub = publicadorDa(conta, token, ctx);
    const containerId = await def.criarContainers(pub, dados, { restanteMs: () => prazo - ctx.now() });

    const rascunho = {
      v: 1,
      conta: conta.slug,
      tipo,
      containerId,
      itens: dados.itens,
      legenda: dados.legenda,
      criadoEm: new Date(criadoEm).toISOString(),
      expiraEm: new Date(criadoEm + VALIDADE_RASCUNHO_MS).toISOString(),
    };
    const id = assinarRascunho(rascunho, segredo);
    console.log(`[${conta.slug}] rascunho ${tipo} pronto: container ${containerId}, ${dados.itens.length} itens. Nada publicado.`);

    return res.status(201).json({
      id,
      preview: urlPreview(req, id),
      conta: conta.slug,
      username: conta.username,
      tipo,
      containerId,
      itens: dados.itens.length,
      expiraEm: rascunho.expiraEm,
      aviso: "Nada foi publicado. Mande o preview e só publique depois do OK do Vinicius: POST /api/midia/publicar {id, confirmar: true}.",
    });
  });
}

// ── POST /api/midia/publicar ──────────────────────────────────────────────
// body: { id, confirmar: true }

export async function rotaPublicar(req, res, opcoes = {}) {
  const ctx = contexto(opcoes);
  return tratar(res, ctx, async () => {
    exigirMetodo(req, res, "POST");
    const segredo = autenticar(req, ctx.env);
    const corpo = lerCorpo(req);

    // Booleano estrito: "true", 1, "sim" NÃO publicam.
    if (corpo.confirmar !== true) {
      throw new ErroHttp(400, "publicar exige confirmar: true (booleano). Só depois do OK do Vinicius.");
    }
    const rascunho = lerRascunho(corpo.id, segredo, ctx.now());
    if (ctx.tipoFixo && rascunho.tipo !== ctx.tipoFixo) {
      throw new ErroHttp(400, `este rascunho é ${rascunho.tipo}; esta rota só publica ${ctx.tipoFixo}. Use /api/midia/publicar.`);
    }
    const { nome: tipo } = tipoDefinido(rascunho.tipo);
    const conta = contaObrigatoria(rascunho.conta);
    const token = tokenObrigatorio(conta, ctx);
    const pub = publicadorDa(conta, token, ctx);

    // 1. o container ainda está FINISHED? (EXPIRED → 410, PUBLISHED → 409)
    await pub.aguardarStatus(rascunho.containerId, { timeoutMs: ORCAMENTO_CHECAGEM_PUBLICAR_MS });

    // 2. cota de 24h do Meta. Atingiu → 429 e NÃO chama media_publish.
    const limite = await pub.checarLimitePublicacao();
    if (limite.atingido) {
      throw new ErroHttp(
        429,
        `limite de publicação do Instagram atingido (${limite.usado}/${limite.total} nas últimas 24h). Nada foi publicado; tente mais tarde (o rascunho vale até ${rascunho.expiraEm}).`
      );
    }

    // 3. publica
    const mediaId = await pub.publicarContainer(rascunho.containerId);
    console.log(`[${conta.slug}] ${tipo} PUBLICADO: media ${mediaId} (container ${rascunho.containerId}).`);

    // 4. permalink. Daqui pra frente o post JÁ está no ar: falha aqui não
    //    pode virar erro, senão alguém tenta de novo achando que não publicou.
    let permalink = null;
    let aviso;
    try {
      permalink = await pub.buscarPermalink(mediaId);
    } catch (e) {
      aviso = `publicado, mas não deu pra buscar o permalink: ${sanitizar(e.message, ctx.segredos)}`;
      console.warn(`[${conta.slug}] ${aviso}`);
    }

    return res.status(200).json({
      publicado: true,
      mediaId,
      permalink,
      conta: conta.slug,
      username: conta.username,
      tipo,
      quota: { usado: limite.usado + 1, total: limite.total },
      ...(aviso ? { aviso } : {}),
    });
  });
}

// ── GET /api/midia/preview?id=... ─────────────────────────────────────────
//
// Autenticação do preview (decisão):
//   - O id é assinado com chave derivada do PUBLICAR_SECRET e só é emitido
//     pra quem chamou /rascunho com o segredo. Ele já é a prova, então o link
//     abre no navegador (onde não dá pra mandar header) e pode ir por WhatsApp
//     pro Vinicius aprovar.
//   - Ele só dá LEITURA do que o próprio id carrega (URLs que já são públicas
//     + legenda). Não faz fetch no Graph e não tem botão nem form de publicar.
//   - Publicar SEMPRE exige o Bearer: o id sozinho nunca publica.
//   - Se vier header Authorization, ele precisa estar certo (401 senão).
//   - Sem PUBLICAR_SECRET no servidor → 503, igual às outras rotas.

export async function rotaPreview(req, res, opcoes = {}) {
  const ctx = contexto(opcoes);
  return tratar(
    res,
    ctx,
    async () => {
      exigirMetodo(req, res, "GET");
      const segredo = exigirSegredo(ctx.env);
      const bearer = bearerDoHeader(req);
      if (bearer !== undefined && !iguaisSeguro(bearer, segredo)) {
        throw new ErroHttp(401, "não autorizado: Authorization: Bearer errado.");
      }
      const id = req.query?.id ?? new URL(req.url || "/", "http://x").searchParams.get("id");
      const rascunho = lerRascunho(id, segredo, ctx.now());
      const conta = contaPorSlug(rascunho.conta);

      cabecalhosPreview(res);
      return res.status(200).send(paginaPreview(rascunho, conta));
    },
    { html: true }
  );
}

function cabecalhosPreview(res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // As imagens vêm de outro host: sem Referer, o id assinado não vaza pra ele.
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; img-src https:; media-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
}

const ESTILO = `
  body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#111;color:#eee}
  main{max-width:720px;margin:0 auto;padding:16px}
  .faixa{background:#ffd54a;color:#111;padding:10px 12px;border-radius:8px;font-weight:600}
  .meta{color:#aaa;font-size:13px}
  .slides{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x mandatory;padding:12px 0}
  figure{margin:0;flex:0 0 85%;scroll-snap-align:center}
  figure img,figure video{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:6px;background:#222}
  figcaption{color:#aaa;font-size:12px;text-align:center}
  pre{white-space:pre-wrap;word-wrap:break-word;background:#1c1c1c;padding:12px;border-radius:8px;font:inherit}
`;

function paginaPreview(r, conta) {
  const handle = conta ? `@${conta.username}` : r.conta;
  const slides = r.itens
    .map((url, i) => {
      const src = escaparHtml(url);
      const midia = /\.(mp4|mov)$/i.test(new URL(url).pathname)
        ? `<video src="${src}" controls muted playsinline></video>`
        : `<img src="${src}" alt="slide ${i + 1}" loading="lazy">`;
      return `<figure>${midia}<figcaption>${i + 1}/${r.itens.length}</figcaption></figure>`;
    })
    .join("\n");
  const legenda = r.legenda ? escaparHtml(r.legenda) : "<em>(sem legenda)</em>";
  const caracteres = Array.from(r.legenda || "").length;

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Prévia ${escaparHtml(r.tipo)} — ${escaparHtml(handle)}</title>
<style>${ESTILO}</style></head>
<body><main>
<p class="faixa">PRÉVIA — nada foi publicado. Só publica com confirmação do Vinicius.</p>
<h1>${escaparHtml(handle)} · ${escaparHtml(r.tipo)} · ${r.itens.length} slides</h1>
<p class="meta">Rascunho criado em ${escaparHtml(r.criadoEm)} · expira em ${escaparHtml(r.expiraEm)} · container ${escaparHtml(r.containerId)}</p>
<div class="slides">
${slides}
</div>
<h2>Legenda <span class="meta">(${caracteres}/2200)</span></h2>
<pre>${legenda}</pre>
</main></body></html>`;
}

function paginaErro(status, mensagem) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Prévia indisponível (${status})</title><style>${ESTILO}</style></head>
<body><main><h1>Prévia indisponível (${status})</h1><p>${escaparHtml(mensagem)}</p></main></body></html>`;
}
