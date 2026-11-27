// Lógica da rota de publicação. Os arquivos em api/midia/ e api/carrossel/
// só chamam esta função (o alias fica com 3 linhas).
//
//   POST /api/midia/publicar   valida, cria os containers e publica, numa
//                              chamada só. Exige confirmar: true.
//
// Não existe rascunho nem preview do lado do servidor: o Vinicius aprova as
// imagens e o texto ANTES, e a chamada só é feita com o ok dele.
//
// A função recebe (req, res, opcoes). Em produção opcoes vem vazio e cai em
// process.env / fetch global / relógio de verdade; os testes injetam tudo.
//
// Nunca entra token em resposta ou log: todo erro passa por sanitizar() com
// o token da conta e o PUBLICAR_SECRET na lista do que esconder.

import { contaPorSlug, tokenDaConta } from "../contas.js";
import { ErroHttp, autenticar, sanitizar } from "./seguranca.js";
import { criarPublicador, tipoDefinido } from "./instagram-publicacao.js";
// Orçamento dos containers (240s; Reels 270s via TIPOS.REELS.orcamentoMs)
// dentro do maxDuration da função (300s, vercel.json). A relação entre os
// tempos está explicada em tempos.js.
import { ORCAMENTO_CONTAINERS_MS } from "./tempos.js";

function contexto(opcoes = {}) {
  const env = opcoes.env || process.env;
  return {
    env,
    fetch: opcoes.fetch || globalThis.fetch,
    sleep: opcoes.sleep,
    now: opcoes.now || Date.now,
    intervaloMs: opcoes.intervaloMs,
    // undefined: usa o do tipo (def.orcamentoMs) ou o padrão; os testes forçam
    orcamentoMs: opcoes.orcamentoMs,
    tipoFixo: opcoes.tipoFixo,
    // tudo que nunca pode sair numa resposta/log; o token entra depois
    segredos: [env.PUBLICAR_SECRET].filter(Boolean),
    // vira true imediatamente ANTES de chamar o media_publish: daí em diante
    // um erro não garante que nada foi publicado
    mediaPublishChamado: false,
  };
}

// Erro esperado (ErroHttp) volta com o status dele. Inesperado vira 500
// genérico e o detalhe (sanitizado) vai só pro log.
//
// Se o media_publish NÃO foi chamado, o erro leva `publicado: false`: é
// certeza que nada foi pro perfil (o CLI usa isso pra decidir se apaga os
// temporários). Se foi chamado e deu erro, o campo fica de fora: resultado
// indefinido, confira o perfil.
async function tratar(res, ctx, fn) {
  try {
    return await fn();
  } catch (e) {
    const esperado = e instanceof ErroHttp;
    const status = esperado ? e.status : 500;
    const mensagem = esperado ? sanitizar(e.message, ctx.segredos) : "erro interno; veja o log da função.";
    if (!esperado) console.error("midia: erro inesperado:", sanitizar(e?.stack || e?.message || e, ctx.segredos));
    return res.status(status).json({ erro: mensagem, ...(ctx.mediaPublishChamado ? {} : { publicado: false }) });
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

// ── POST /api/midia/publicar ──────────────────────────────────────────────
// body: { conta: "eterniza", tipo: "CAROUSEL", itens: [{ url }], legenda, confirmar: true }
//       { conta: "eterniza", tipo: "STORIES", itens: [{ url }], confirmar: true }  (1 JPEG, sem legenda)
//       { conta: "eterniza", tipo: "REELS", itens: [{ video_url }], legenda, cover_url?, share_to_feed?, confirmar: true }
// No alias /api/carrossel/publicar o tipo é fixo (CAROUSEL) e pode ser omitido.

export async function rotaPublicar(req, res, opcoes = {}) {
  const ctx = contexto(opcoes);
  return tratar(res, ctx, async () => {
    // ── 1. Tudo que pode recusar sem tocar no Instagram (zero fetch) ──────
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      throw new ErroHttp(405, `método ${req.method} não permitido; use POST.`);
    }
    autenticar(req, ctx.env); // 503 sem segredo, 401 errado
    const corpo = lerCorpo(req);

    // Booleano estrito: "true", 1, "sim" NÃO publicam.
    if (corpo.confirmar !== true) {
      throw new ErroHttp(400, "publicar exige confirmar: true (booleano). Só com o ok do Vinicius nas imagens e no texto.");
    }

    const tipoPedido = corpo.tipo ?? ctx.tipoFixo;
    if (ctx.tipoFixo && String(tipoPedido).toUpperCase() !== ctx.tipoFixo) {
      throw new ErroHttp(400, `esta rota só aceita tipo ${ctx.tipoFixo}; use /api/midia/publicar.`);
    }
    const { nome: tipo, def } = tipoDefinido(tipoPedido); // 400 desconhecido, 501 não implementado
    const conta = typeof corpo.conta === "string" ? contaPorSlug(corpo.conta) : undefined;
    if (!conta) throw new ErroHttp(400, `conta "${corpo.conta ?? ""}" não existe em api/contas.js.`);
    const dados = def.validar(corpo);

    const token = tokenDaConta(conta, ctx.env);
    if (!token) {
      throw new ErroHttp(503, `${conta.tokenEnv} não está configurado neste ambiente (hoje ele só existe em production).`);
    }
    ctx.segredos.push(token);

    const pub = criarPublicador({
      userId: conta.userId,
      token,
      fetch: ctx.fetch,
      sleep: ctx.sleep,
      now: ctx.now,
      intervaloMs: ctx.intervaloMs,
    });

    // ── 2. Cota de 24h ANTES de criar qualquer container ──────────────────
    const limite = await pub.checarLimitePublicacao();
    if (limite.atingido) {
      throw new ErroHttp(
        429,
        `limite de publicação do Instagram atingido (${limite.usado}/${limite.total} nas últimas 24h). Nada foi criado nem publicado; tente mais tarde.`
      );
    }

    // ── 3. Containers (carrossel: filhos + final; story/Reels: um só), FINISHED ─
    const orcamento = ctx.orcamentoMs ?? def.orcamentoMs ?? ORCAMENTO_CONTAINERS_MS;
    const prazo = ctx.now() + orcamento;
    const containerId = await def.criarContainers(pub, dados, { restanteMs: () => prazo - ctx.now() });

    // ── 4. Publica ────────────────────────────────────────────────────────
    ctx.mediaPublishChamado = true;
    const mediaId = await pub.publicarContainer(containerId);
    const n = dados.itens.length;
    console.log(`[${conta.slug}] ${tipo} PUBLICADO: media ${mediaId} (container ${containerId}, ${n} ${n === 1 ? "item" : "itens"}).`);

    // ── 5. Permalink. O post JÁ está no ar: falha aqui não pode virar erro,
    //       senão alguém tenta de novo achando que não publicou.
    //       Tipos com permalinkOpcional (STORIES): sem permalink é normal,
    //       volta permalink: null sem aviso. Os outros (CAROUSEL, REELS)
    //       voltam com aviso, tanto se o GET falhar quanto se vier sem link.
    let permalink = null;
    let aviso;
    try {
      permalink = await pub.buscarPermalink(mediaId);
    } catch (e) {
      const detalhe = sanitizar(e.message, ctx.segredos);
      if (def.permalinkOpcional) {
        console.log(`[${conta.slug}] ${tipo} ${mediaId} sem permalink (normal pra ${tipo}): ${detalhe}`);
      } else {
        aviso = `publicado, mas não deu pra buscar o permalink: ${detalhe}. NÃO publique de novo; confira no perfil.`;
        console.warn(`[${conta.slug}] ${aviso}`);
      }
    }
    // Graph respondeu, mas sem permalink: mesmo aviso (carrossel e Reels têm link).
    if (!permalink && !aviso && !def.permalinkOpcional) {
      aviso = "publicado, mas o Instagram não devolveu o permalink. NÃO publique de novo; confira no perfil.";
      console.warn(`[${conta.slug}] ${aviso}`);
    }

    return res.status(200).json({
      mediaId,
      permalink,
      username: conta.username,
      quota: { usado: limite.usado + 1, total: limite.total },
      conta: conta.slug,
      tipo,
      ...(aviso ? { aviso } : {}),
    });
  });
}
