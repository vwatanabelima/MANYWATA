// Publicação de mídia no Instagram (Instagram API with Instagram Login).
//
// Pelo lado do Meta, publicar é: criar o "container" (POST /{user-id}/media),
// esperar ele ficar FINISHED e chamar POST /{user-id}/media_publish com o id
// dele. A rota faz tudo numa chamada só (a aprovação do Vinicius acontece
// antes, fora daqui).
//
// Este módulo não sabe nada de HTTP de entrada nem de autenticação (isso é
// rotas-midia.js). Tudo que fala com o mundo é injetado (fetch, sleep, now),
// pra testar sem rede e sem esperar de verdade.
//
// O token vai no header Authorization: Bearer (graph.instagram.com aceita),
// nunca na query string, então não aparece em URL nenhuma. Mesmo assim toda
// mensagem de erro passa por sanitizar().
//
// Reels pelo CLI usa outro caminho (criarContainerResumivel +
// enviarVideoResumivel): container com upload_type=resumable e o MP4 vai
// direto pro rupload.facebook.com com "Authorization: OAuth <token>". Isso
// roda só na máquina do operador; a rota da Vercel não recebe o vídeo nem
// devolve o token.

import { ErroHttp, sanitizar, validarUrlPublica } from "./seguranca.js";
import {
  ORCAMENTO_REELS_MS,
  STATUS_CHECAGENS_MINIMAS,
  STATUS_ESPERA_MINIMA_MS,
  STATUS_INTERVALO_INICIAL_MS,
  STATUS_INTERVALO_MAX_MS,
} from "./tempos.js";

export const GRAPH = "https://graph.instagram.com/v21.0";

// Upload resumível de vídeo (Reels pelo CLI). O POST /media com
// upload_type=resumable devolve { id, uri }; o binário vai pra essa uri com
// "Authorization: OAuth <token>". Se o Meta não devolver uri, monta-se esta
// (mesma versão do GRAPH). Só aceitamos uri neste host e neste caminho: o
// token vai junto, então NUNCA mandamos pra outro lugar.
export const RUPLOAD_HOST = "rupload.facebook.com";
export const RUPLOAD_CAMINHO = "/ig-api-upload/";
export const RUPLOAD = `https://${RUPLOAD_HOST}${RUPLOAD_CAMINHO}${new URL(GRAPH).pathname.replace(/^\//, "")}`;

// uri de upload aceitável: https://rupload.facebook.com/ig-api-upload/...,
// sem usuário/senha nem porta. Devolve a URL normalizada ou null.
export function uriRuploadValida(uri) {
  let u;
  try {
    u = new URL(String(uri));
  } catch {
    return null;
  }
  const ok =
    u.protocol === "https:" &&
    u.hostname.toLowerCase() === RUPLOAD_HOST &&
    !u.port &&
    !u.username &&
    !u.password &&
    u.pathname.startsWith(RUPLOAD_CAMINHO);
  return ok ? u.href : null;
}

// Regras do Meta (não do código). Fonte: docs de Content Publishing.
export const LIMITES = {
  legendaMaxCaracteres: 2200,
  legendaMaxHashtags: 30,
  legendaMaxMencoes: 20,
  carrosselMinItens: 2,
  carrosselMaxItens: 10,
  quotaPadrao24h: 50, // posts publicados via API por conta a cada 24h
};

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// O que conferir quando o Meta devolve status ERROR no container.
const DICA_ERRO_IMAGEM = "Confira se a URL abre de fora e é um JPEG.";
const DICA_ERRO_VIDEO =
  "Confira se a URL abre de fora e se o vídeo está nos limites do Reels (MP4/MOV, H.264/HEVC + AAC, 3s a 15min, até 300 MB).";
// Mesma coisa, pro vídeo que subiu direto pelo rupload (não tem URL).
export const DICA_ERRO_VIDEO_UPLOAD =
  "Confira se o vídeo está nos limites do Reels (MP4/MOV, H.264/HEVC + AAC, 3s a 15min, até 300 MB).";

// ── Cliente do Graph para UMA conta ───────────────────────────────────────

export function criarPublicador({
  userId,
  token,
  fetch: fetchFn = globalThis.fetch,
  sleep = esperar,
  now = Date.now,
  intervaloMs = STATUS_INTERVALO_INICIAL_MS,
  intervaloMaxMs = STATUS_INTERVALO_MAX_MS,
  esperaMinimaMs = STATUS_ESPERA_MINIMA_MS,
  checagensMinimas = STATUS_CHECAGENS_MINIMAS,
}) {
  // undefined vindo das opções da rota cai no padrão
  intervaloMs ??= STATUS_INTERVALO_INICIAL_MS;
  intervaloMaxMs = Math.max(intervaloMaxMs ?? STATUS_INTERVALO_MAX_MS, intervaloMs);

  async function graph(metodo, caminho, params = {}) {
    const url = new URL(`${GRAPH}/${caminho}`);
    const init = { method: metodo, headers: { Authorization: `Bearer ${token}` } };
    if (metodo === "GET") {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    } else {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(params);
    }

    let resposta;
    try {
      resposta = await fetchFn(url.toString(), init);
    } catch (e) {
      throw new ErroHttp(502, sanitizar(`falha de rede ao chamar o Instagram (${metodo} ${caminho}): ${e?.message}`, [token]));
    }
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok || dados?.error) {
      const detalhe = dados?.error?.message || `HTTP ${resposta.status}`;
      throw new ErroHttp(502, sanitizar(`Instagram recusou ${metodo} ${caminho}: ${detalhe}`, [token]));
    }
    return dados;
  }

  // POST /{user-id}/media. Os params dependem do tipo (ver TIPOS).
  async function criarContainer(params) {
    const r = await graph("POST", `${userId}/media`, params);
    if (!r.id) throw new ErroHttp(502, "Instagram não devolveu o id do container.");
    return String(r.id);
  }

  // ── Reels por upload resumível (só o CLI usa; a rota segue com video_url) ──
  //
  // 1. POST /{user-id}/media com media_type=REELS + upload_type=resumable (+
  //    caption se houver). SEM video_url. Devolve { id, uri }. Se a uri vier,
  //    usa ela (só se for rupload.facebook.com/ig-api-upload/...); se não
  //    vier, monta RUPLOAD/{id}.
  //    Capa (opcional, uma OU outra; o Meta ignora thumb_offset se vier
  //    cover_url, então nem deixamos mandar as duas):
  //      coverUrl    → cover_url: JPEG numa URL https pública (o Meta baixa)
  //      thumbOffset → thumb_offset: frame do próprio vídeo, em ms (inteiro >= 0)
  //    Sem nenhuma, o Instagram escolhe o frame. Campo ausente = não vai.
  async function criarContainerResumivel({ legenda, coverUrl, thumbOffset } = {}) {
    const temCapa = coverUrl !== undefined && coverUrl !== null && coverUrl !== "";
    const temOffset = thumbOffset !== undefined && thumbOffset !== null;
    if (temCapa && temOffset) throw new ErroHttp(400, "use cover_url OU thumb_offset, não os dois.");
    if (temOffset && (!Number.isSafeInteger(thumbOffset) || thumbOffset < 0)) {
      throw new ErroHttp(400, "thumb_offset precisa ser um inteiro >= 0 (milissegundos).");
    }
    const params = { media_type: "REELS", upload_type: "resumable" };
    if (legenda) params.caption = legenda;
    if (temCapa) params.cover_url = validarUrlPublica(coverUrl, "cover_url");
    if (temOffset) params.thumb_offset = thumbOffset;
    const r = await graph("POST", `${userId}/media`, params);
    if (!r.id) throw new ErroHttp(502, "Instagram não devolveu o id do container.");
    const id = String(r.id);
    if (r.uri === undefined || r.uri === null || r.uri === "") {
      return { id, uri: `${RUPLOAD}/${encodeURIComponent(id)}` };
    }
    const uri = uriRuploadValida(r.uri);
    if (!uri) {
      let host = "?";
      try {
        host = new URL(String(r.uri)).host || "?";
      } catch {
        // uri nem é URL
      }
      throw new ErroHttp(
        502,
        sanitizar(
          `Instagram devolveu uma uri de upload fora de https://${RUPLOAD_HOST}${RUPLOAD_CAMINHO} (host: ${host}); o vídeo e o token não foram enviados pra lá.`,
          [token]
        )
      );
    }
    return { id, uri };
  }

  // 2. POST do binário na uri, de uma vez (offset 0, sem retomada). Headers
  //    como na doc: Authorization: OAuth <token>, offset, file_size. corpo é
  //    o MP4 (Buffer/Uint8Array/Blob). Sucesso = HTTP ok + {"success": true}.
  //    Qualquer outra coisa (HTTP de erro, success ausente, rede, timeout) →
  //    ErroHttp; quem chama sabe que o media_publish ainda não aconteceu.
  async function enviarVideoResumivel(uri, { corpo, tamanho, timeoutMs } = {}) {
    const destino = uriRuploadValida(uri);
    if (!destino) throw new ErroHttp(400, `uri de upload recusada: precisa ser https://${RUPLOAD_HOST}${RUPLOAD_CAMINHO}...`);
    if (!Number.isSafeInteger(tamanho) || tamanho <= 0) throw new ErroHttp(400, "tamanho do vídeo inválido pro upload.");

    const init = {
      method: "POST",
      headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(tamanho) },
      body: corpo,
    };
    if (timeoutMs) init.signal = AbortSignal.timeout(timeoutMs);

    let resposta;
    try {
      resposta = await fetchFn(destino, init);
    } catch (e) {
      const abortou = e?.name === "TimeoutError" || e?.name === "AbortError";
      throw new ErroHttp(
        502,
        sanitizar(
          abortou
            ? `upload do vídeo pro ${RUPLOAD_HOST} não terminou em ${Math.round(timeoutMs / 1000)}s.`
            : `falha de rede no upload do vídeo pro ${RUPLOAD_HOST}: ${e?.message}`,
          [token]
        )
      );
    }
    const dados = await resposta.json().catch(() => null);
    if (!resposta.ok || dados?.success !== true) {
      const detalhe =
        dados?.debug_info?.message || dados?.error?.message || dados?.message || (resposta.ok ? "resposta sem success: true" : `HTTP ${resposta.status}`);
      throw new ErroHttp(502, sanitizar(`${RUPLOAD_HOST} recusou o upload do vídeo (HTTP ${resposta.status}): ${detalhe}`, [token]));
    }
    return dados;
  }

  // Polling de status_code até FINISHED. Imagem costuma sair em segundos;
  // vídeo (Reels) pode levar minutos. timeoutMs é o que sobrou do orçamento
  // da rota e pode chegar aqui curto, zero ou negativo (criação lenta). Mesmo
  // assim: sempre checa de verdade, e só desiste depois de esperar pelo menos
  // esperaMinimaMs E de ter feito checagensMinimas. A mensagem de timeout
  // mostra o tempo REAL esperado aqui dentro.
  //
  // signal (opcional): quando outro container do mesmo lote já falhou, para
  // de checar este na próxima volta, sem publicar nada.
  // dica (opcional): o que conferir quando o container dá ERROR (padrão:
  // imagem JPEG; Reels passa a dica de vídeo).
  async function aguardarStatus(containerId, { timeoutMs = 30_000, signal, dica = DICA_ERRO_IMAGEM } = {}) {
    const inicio = now();
    const limite = Math.max(Number(timeoutMs) || 0, esperaMinimaMs);
    let intervalo = intervaloMs;
    let checagens = 0;
    for (;;) {
      if (signal?.aborted) throw cancelado(containerId);
      const r = await graph("GET", containerId, { fields: "status_code,status" });
      checagens++;
      const codigo = r.status_code;
      if (codigo === "FINISHED") return;
      if (codigo === "ERROR") {
        throw new ErroHttp(
          502,
          sanitizar(`container ${containerId} falhou no Instagram (ERROR): ${r.status || "sem detalhe"}. ${dica}`, [token])
        );
      }
      if (codigo === "EXPIRED") {
        throw new ErroHttp(410, `container ${containerId} expirou no Instagram antes de publicar. Nada foi publicado; rode de novo.`);
      }
      if (codigo === "PUBLISHED") {
        throw new ErroHttp(409, `container ${containerId} já foi publicado. Nada foi feito.`);
      }
      const decorrido = Math.max(0, now() - inicio);
      const restante = limite - decorrido;
      if (restante <= 0 && checagens >= checagensMinimas) {
        throw new ErroHttp(
          504,
          `container ${containerId} não ficou pronto em ${Math.round(decorrido / 1000)}s (último status: ${codigo || "desconhecido"}). Nada foi publicado.`
        );
      }
      // restante <= 0 com checagens faltando: espera o intervalo cheio.
      await sleep(restante > 0 ? Math.min(intervalo, restante) : intervalo);
      intervalo = Math.min(Math.round(intervalo * 1.5), intervaloMaxMs);
    }
  }

  function cancelado(containerId) {
    return new ErroHttp(502, `espera do container ${containerId} cancelada: outro item do mesmo post falhou.`);
  }

  // GET /{user-id}/content_publishing_limit. Falha FECHADA: se não der pra
  // ler a cota, não publica.
  async function checarLimitePublicacao() {
    const r = await graph("GET", `${userId}/content_publishing_limit`, { fields: "quota_usage,config" });
    const d = r.data?.[0];
    if (typeof d?.quota_usage !== "number") {
      throw new ErroHttp(502, "não deu pra ler o limite de publicação do Instagram; nada foi publicado.");
    }
    const total = Number(d.config?.quota_total) || LIMITES.quotaPadrao24h;
    return { usado: d.quota_usage, total, atingido: d.quota_usage >= total };
  }

  // POST /{user-id}/media_publish. Devolve o id da mídia publicada.
  async function publicarContainer(containerId) {
    const r = await graph("POST", `${userId}/media_publish`, { creation_id: containerId });
    if (!r.id) throw new ErroHttp(502, "Instagram não devolveu o id da mídia publicada.");
    return String(r.id);
  }

  async function buscarPermalink(mediaId) {
    const r = await graph("GET", mediaId, { fields: "permalink" });
    return r.permalink || null;
  }

  return {
    now,
    criarContainer,
    criarContainerResumivel,
    enviarVideoResumivel,
    aguardarStatus,
    checarLimitePublicacao,
    publicarContainer,
    buscarPermalink,
  };
}

// ── Validações comuns ─────────────────────────────────────────────────────

// Vale pra feed, carrossel e Reels (Stories não têm legenda).
export function validarLegenda(legenda) {
  if (legenda === undefined || legenda === null) return "";
  if (typeof legenda !== "string") throw new ErroHttp(400, "legenda precisa ser texto.");
  const texto = legenda.replace(/\r\n/g, "\n").trim();

  const caracteres = Array.from(texto).length;
  if (caracteres > LIMITES.legendaMaxCaracteres) {
    throw new ErroHttp(400, `legenda com ${caracteres} caracteres; o máximo do Instagram é ${LIMITES.legendaMaxCaracteres}.`);
  }
  const hashtags = texto.match(/#[\p{L}\p{N}_]+/gu) || [];
  if (hashtags.length > LIMITES.legendaMaxHashtags) {
    throw new ErroHttp(400, `legenda com ${hashtags.length} hashtags; o máximo do Instagram é ${LIMITES.legendaMaxHashtags}.`);
  }
  // @ precedido de letra/número é e-mail, não menção.
  const mencoes = texto.match(/(?<![\p{L}\p{N}_.])@[\p{L}\p{N}_.]+/gu) || [];
  if (mencoes.length > LIMITES.legendaMaxMencoes) {
    throw new ErroHttp(400, `legenda com ${mencoes.length} menções (@); o máximo do Instagram é ${LIMITES.legendaMaxMencoes}.`);
  }
  return texto;
}

// O Meta só aceita JPEG em carrossel/feed/story de imagem. Dá pra checar pela extensão;
// URL sem extensão passa (o Meta recusa depois com status ERROR se não for).
export function exigirJpeg(url, rotulo) {
  const caminho = new URL(url).pathname.toLowerCase();
  const ext = /\.([a-z0-9]+)$/.exec(caminho)?.[1];
  if (ext && ext !== "jpg" && ext !== "jpeg") {
    throw new ErroHttp(400, `${rotulo}: o Instagram só aceita JPEG aqui (veio .${ext}).`);
  }
}

// ── Paralelismo ───────────────────────────────────────────────────────────

// Roda as tarefas ao mesmo tempo e devolve os resultados NA ORDEM das
// tarefas. Se alguma falhar: avisa as outras pelo signal (quem respeita,
// para), espera todas terminarem (nada fica rodando depois da resposta) e
// lança o PRIMEIRO erro, com o rótulo do item ("slide 3 de 9: ...").
export async function emParalelo(tarefas, rotulo = (i) => `item ${i + 1}`) {
  const controle = new AbortController();
  let primeiro;
  const resultados = await Promise.allSettled(
    tarefas.map(async (tarefa, i) => {
      try {
        return await tarefa(controle.signal);
      } catch (e) {
        if (!primeiro) {
          primeiro = { e, i };
          controle.abort();
        }
        throw e;
      }
    })
  );
  if (primeiro) {
    const { e, i } = primeiro;
    if (e instanceof ErroHttp) throw new ErroHttp(e.status, `${rotulo(i)}: ${e.message}`);
    throw e;
  }
  return resultados.map((r) => r.value);
}

// ── Registro de tipos ─────────────────────────────────────────────────────
//
// Cada tipo de mídia é uma entrada. A rota é genérica: pega o tipo do body,
// chama validar() (antes de qualquer fetch) e criarContainers(), e publica o
// container que voltar. Tipo novo: implementar a entrada e virar
// `implementado: true`.
//
//   validar(corpo)                     → { itens: [url...], legenda?, ... }  (ou ErroHttp 400/501)
//   criarContainers(pub, dados, ctx)   → id do container FINAL, já FINISHED
//     ctx.restanteMs()                 → quanto do orçamento de tempo sobrou
//   orcamentoMs (opcional)             → orçamento dos containers deste tipo
//                                        (padrão ORCAMENTO_CONTAINERS_MS)
//   permalinkOpcional (opcional)       → true: falha ao buscar o permalink
//                                        depois de publicar não gera aviso

export const TIPOS = {
  CAROUSEL: {
    implementado: true,
    descricao: "carrossel de 2 a 10 imagens JPEG",

    validar(corpo) {
      const itens = corpo.itens;
      if (!Array.isArray(itens)) {
        throw new ErroHttp(400, 'itens precisa ser uma lista: [{"url": "https://..."}].');
      }
      const { carrosselMinItens: min, carrosselMaxItens: max } = LIMITES;
      if (itens.length < min || itens.length > max) {
        throw new ErroHttp(400, `carrossel precisa de ${min} a ${max} itens (veio ${itens.length}).`);
      }
      // Só URL https pública: quem baixa a imagem é o servidor do Meta. Onde
      // hospedar fica fora daqui (README, "Hospedagem das imagens").
      const urls = itens.map((item, i) => {
        const rotulo = `itens[${i}].url`;
        const url = validarUrlPublica(item?.url, rotulo);
        exigirJpeg(url, rotulo);
        return url;
      });
      return { itens: urls, legenda: validarLegenda(corpo.legenda) };
    },

    async criarContainers(pub, { itens, legenda }, ctx) {
      const total = itens.length;
      const rotulo = (i) => `slide ${i + 1} de ${total}`;

      // 1. um container-filho por slide, TODOS AO MESMO TEMPO. Cada POST
      //    /media leva segundos (o Meta baixa a imagem antes de responder);
      //    em sequência, 9 slides comiam o orçamento inteiro. emParalelo
      //    devolve na ordem do array, não na ordem em que as respostas
      //    chegam. Se algum falhar, os filhos criados ficam órfãos (não
      //    aparecem no perfil; o Instagram descarta em 24h).
      const filhos = await emParalelo(
        itens.map((url) => () => pub.criarContainer({ image_url: url, is_carousel_item: true })),
        rotulo
      );
      // 2. espera os filhos, também em paralelo. O primeiro que falhar
      //    cancela a espera dos outros.
      await emParalelo(
        filhos.map((id) => (signal) => pub.aguardarStatus(id, { timeoutMs: ctx.restanteMs(), signal })),
        rotulo
      );
      // 3. container do carrossel, com os filhos na mesma ordem dos slides
      const params = { media_type: "CAROUSEL", children: filhos.join(",") };
      if (legenda) params.caption = legenda;
      const id = await pub.criarContainer(params);
      await pub.aguardarStatus(id, { timeoutMs: ctx.restanteMs() });
      return id;
    },
  },

  // Reels: 1 vídeo (MP4/MOV) em URL https pública, legenda opcional,
  // cover_url (JPEG) e share_to_feed (booleano) opcionais no corpo.
  //
  // Tempo: um container só, então usa ORCAMENTO_REELS_MS (270s) em vez dos
  // 240s do carrossel. Vídeo longo ainda pode não ficar FINISHED dentro dos
  // 300s da função (504, nada publicado). Dividir em duas chamadas ("cria o
  // container" + "checa status e publica") é outro desenho, fora daqui.
  REELS: {
    implementado: true,
    descricao: "Reels de 1 vídeo MP4/MOV (legenda, cover_url e share_to_feed opcionais)",
    orcamentoMs: ORCAMENTO_REELS_MS,

    validar(corpo) {
      const itens = corpo.itens;
      if (!Array.isArray(itens)) {
        throw new ErroHttp(400, 'itens precisa ser uma lista com 1 item: [{"video_url": "https://.../video.mp4"}].');
      }
      if (itens.length !== 1) {
        throw new ErroHttp(400, `Reels leva exatamente 1 vídeo (veio ${itens.length}).`);
      }
      const videoUrl = urlDoVideo(itens[0]);

      const dados = { itens: [videoUrl], legenda: validarLegenda(corpo.legenda) };
      if (corpo.cover_url !== undefined && corpo.cover_url !== null) {
        const capa = validarUrlPublica(corpo.cover_url, "cover_url");
        exigirJpeg(capa, "cover_url");
        dados.coverUrl = capa;
      }
      if (corpo.share_to_feed !== undefined) {
        // Booleano estrito, como confirmar: "true" ou 1 não valem.
        if (typeof corpo.share_to_feed !== "boolean") {
          throw new ErroHttp(400, "share_to_feed precisa ser booleano (true ou false).");
        }
        dados.shareToFeed = corpo.share_to_feed;
      }
      return dados;
    },

    async criarContainers(pub, { itens, legenda, coverUrl, shareToFeed }, ctx) {
      const params = { media_type: "REELS", video_url: itens[0] };
      if (legenda) params.caption = legenda;
      if (coverUrl) params.cover_url = coverUrl;
      if (shareToFeed !== undefined) params.share_to_feed = shareToFeed;
      const id = await pub.criarContainer(params);
      // ERROR / EXPIRED abortam aqui dentro, antes de qualquer media_publish.
      await pub.aguardarStatus(id, { timeoutMs: ctx.restanteMs(), dica: DICA_ERRO_VIDEO });
      return id;
    },
    // Reels tem permalink: se faltar depois de publicar, volta 200 com aviso.
  },

  // Story de IMAGEM: 1 JPEG, sem legenda (Story não tem caption na API).
  //
  // Story de VÍDEO continua 501 (ver README, "O que falta para Stories de
  // vídeo"). Falta: aceitar video_url (MP4/MOV), criarContainer({
  // media_type: "STORIES", video_url }), o mesmo limite de tempo do Reels
  // (processar vídeo pode passar dos 300s da função) e o bucket aceitar
  // vídeo (hoje só image/jpeg até 8 MB).
  //
  // Stickers interativos (enquete, link, pergunta, menção clicável) NÃO
  // existem na API de publicação: o story sai só com a imagem.
  STORIES: {
    implementado: true,
    descricao: "Story de 1 imagem JPEG, sem legenda (vídeo ainda não)",

    validar(corpo) {
      const itens = corpo.itens;
      if (!Array.isArray(itens)) {
        throw new ErroHttp(400, 'itens precisa ser uma lista com 1 item: [{"url": "https://..."}].');
      }
      if (itens.length !== 1) {
        throw new ErroHttp(400, `story leva exatamente 1 item (veio ${itens.length}). Pra várias imagens, publique um story por vez.`);
      }
      const item = itens[0];
      if (ehVideo(item)) {
        throw new ErroHttp(
          501,
          "story de vídeo ainda não implementado (só imagem JPEG por enquanto). Pra vídeo use tipo REELS. Ver README, \"O que falta para Stories de vídeo\"."
        );
      }
      const url = validarUrlPublica(item?.url, "itens[0].url");
      exigirJpeg(url, "itens[0].url");

      // Story não tem caption. Recusar em vez de ignorar, senão alguém acha
      // que o texto vai aparecer.
      const legenda = corpo.legenda;
      const vazia = legenda === undefined || legenda === null || (typeof legenda === "string" && legenda.trim() === "");
      if (!vazia) {
        throw new ErroHttp(
          400,
          "story não tem legenda no Instagram (a API não aceita caption em STORIES). Tire o campo legenda; texto do story vai na própria imagem."
        );
      }
      return { itens: [url] };
    },

    async criarContainers(pub, { itens }, ctx) {
      const id = await pub.criarContainer({ image_url: itens[0], media_type: "STORIES" });
      await pub.aguardarStatus(id, { timeoutMs: ctx.restanteMs() });
      return id;
    },

    // Story pode não ter permalink (ou o Graph não devolver). Não é erro nem
    // motivo de aviso: o mediaId já confirma a publicação.
    permalinkOpcional: true,
  },
};

// Item de vídeo: campo video_url ou URL terminando em extensão de vídeo.
function ehVideo(item) {
  if (item && typeof item === "object" && item.video_url !== undefined) return true;
  try {
    return /\.(mp4|mov|m4v)$/i.test(new URL(String(item?.url)).pathname);
  } catch {
    return false;
  }
}

const EXT_VIDEO = ["mp4", "mov", "m4v"];
const extensao = (url) => /\.([a-z0-9]+)$/.exec(new URL(url).pathname.toLowerCase())?.[1];

// URL do vídeo do Reels: itens[0].video_url (qualquer caminho, desde que não
// tenha extensão de outra coisa) ou itens[0].url terminando em .mp4/.mov/.m4v.
// https público nos dois casos.
function urlDoVideo(item) {
  if (item && typeof item === "object" && item.video_url !== undefined) {
    const url = validarUrlPublica(item.video_url, "itens[0].video_url");
    const ext = extensao(url);
    if (ext && !EXT_VIDEO.includes(ext)) {
      throw new ErroHttp(400, `itens[0].video_url: Reels precisa de vídeo MP4/MOV (veio .${ext}).`);
    }
    return url;
  }
  if (item?.url === undefined || item?.url === null || item?.url === "") {
    throw new ErroHttp(400, 'itens[0]: falta a URL do vídeo (video_url, ou url terminando em .mp4/.mov/.m4v).');
  }
  const url = validarUrlPublica(item.url, "itens[0].url");
  const ext = extensao(url);
  if (!ext || !EXT_VIDEO.includes(ext)) {
    throw new ErroHttp(
      400,
      `itens[0].url: Reels precisa de vídeo MP4/MOV (${ext ? `veio .${ext}` : "URL sem extensão; use video_url"}).`
    );
  }
  return url;
}

// Resolve o tipo pedido. Desconhecido → 400; conhecido mas não pronto → 501.
export function tipoDefinido(tipo) {
  const nome = typeof tipo === "string" ? tipo.trim().toUpperCase() : "";
  const def = TIPOS[nome];
  if (!def) {
    throw new ErroHttp(400, `tipo "${tipo ?? ""}" desconhecido. Tipos: ${Object.keys(TIPOS).join(", ")}.`);
  }
  if (!def.implementado) {
    const prontos = Object.keys(TIPOS).filter((k) => TIPOS[k].implementado);
    throw new ErroHttp(501, `tipo ${nome} ainda não implementado (${def.descricao}). Hoje: ${prontos.join(", ")}.`);
  }
  return { nome, def };
}
