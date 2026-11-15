// Publicação de mídia no Instagram (Instagram API with Instagram Login).
//
// O Meta publica em duas etapas, e a gente segue as mesmas duas:
//   1. RASCUNHO: cria o "container" (POST /{user-id}/media) e espera ele
//      ficar FINISHED. Nada aparece no perfil. O container vale 24h.
//   2. PUBLICAR: POST /{user-id}/media_publish com o id do container.
//
// Este módulo não sabe nada de HTTP de entrada nem de autenticação (isso é
// rotas-midia.js). Tudo que fala com o mundo é injetado (fetch, sleep, now),
// pra testar sem rede e sem esperar de verdade.
//
// O token vai no header Authorization: Bearer (graph.instagram.com aceita),
// nunca na query string, então não aparece em URL nenhuma. Mesmo assim toda
// mensagem de erro passa por sanitizar().

import { ErroHttp, sanitizar, validarUrlPublica } from "./seguranca.js";

export const GRAPH = "https://graph.instagram.com/v21.0";

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

// ── Cliente do Graph para UMA conta ───────────────────────────────────────

export function criarPublicador({
  userId,
  token,
  fetch: fetchFn = globalThis.fetch,
  sleep = esperar,
  now = Date.now,
  intervaloMs = 2000,
}) {
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

  // Polling de status_code até FINISHED. Imagem costuma sair na hora; vídeo
  // (Reels) pode levar minutos — o timeout é por chamada, pra caber no limite
  // da função da Vercel.
  async function aguardarStatus(containerId, { timeoutMs = 30_000 } = {}) {
    const inicio = now();
    for (;;) {
      const r = await graph("GET", containerId, { fields: "status_code,status" });
      const codigo = r.status_code;
      if (codigo === "FINISHED") return;
      if (codigo === "ERROR") {
        throw new ErroHttp(
          502,
          sanitizar(`container ${containerId} falhou no Instagram (ERROR): ${r.status || "sem detalhe"}. Confira se a URL abre de fora e é um JPEG.`, [token])
        );
      }
      if (codigo === "EXPIRED") {
        throw new ErroHttp(410, `container ${containerId} expirado, gere outro rascunho.`);
      }
      if (codigo === "PUBLISHED") {
        throw new ErroHttp(409, `container ${containerId} já foi publicado. Nada foi feito.`);
      }
      const restante = timeoutMs - (now() - inicio);
      if (restante <= 0) {
        throw new ErroHttp(
          504,
          `container ${containerId} não ficou pronto em ${Math.round(timeoutMs / 1000)}s (último status: ${codigo || "desconhecido"}). Tente de novo em instantes.`
        );
      }
      await sleep(Math.min(intervaloMs, restante));
    }
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

  return { now, criarContainer, aguardarStatus, checarLimitePublicacao, publicarContainer, buscarPermalink };
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

// O Meta só aceita JPEG em carrossel/feed. Dá pra checar pela extensão;
// URL sem extensão passa (o Meta recusa depois com status ERROR se não for).
export function exigirJpeg(url, rotulo) {
  const caminho = new URL(url).pathname.toLowerCase();
  const ext = /\.([a-z0-9]+)$/.exec(caminho)?.[1];
  if (ext && ext !== "jpg" && ext !== "jpeg") {
    throw new ErroHttp(400, `${rotulo}: o Instagram só aceita JPEG aqui (veio .${ext}).`);
  }
}

// ── Registro de tipos ─────────────────────────────────────────────────────
//
// Cada tipo de mídia é uma entrada. As rotas são genéricas: pegam o tipo do
// body, chamam validar() e criarContainers(), e assinam o rascunho. Pra ligar
// Reels ou Stories é só implementar a entrada e virar `implementado: true`.
//
//   validar(corpo)                     → { itens: [url...], legenda }  (ou ErroHttp 400)
//   criarContainers(pub, dados, ctx)   → id do container FINAL, já FINISHED
//     ctx.restanteMs()                 → quanto do orçamento de tempo sobrou

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
      // PONTO DE EXTENSÃO (upload): hoje só URL pública. Quando tiver Vercel
      // Blob (BLOB_READ_WRITE_TOKEN), o upload acontece ANTES, no CLI, e o que
      // chega aqui continua sendo a URL pública devolvida pelo Blob.
      const urls = itens.map((item, i) => {
        const rotulo = `itens[${i}].url`;
        const url = validarUrlPublica(item?.url, rotulo);
        exigirJpeg(url, rotulo);
        return url;
      });
      return { itens: urls, legenda: validarLegenda(corpo.legenda) };
    },

    async criarContainers(pub, { itens, legenda }, ctx) {
      // 1. um container-filho por slide, NA ORDEM. Se algo falhar no meio, os
      //    filhos já criados ficam órfãos e o Instagram descarta em 24h.
      const filhos = [];
      for (const url of itens) {
        filhos.push(await pub.criarContainer({ image_url: url, is_carousel_item: true }));
      }
      // 2. espera cada filho (criados antes, então costumam já estar prontos)
      for (const id of filhos) {
        await pub.aguardarStatus(id, { timeoutMs: ctx.restanteMs() });
      }
      // 3. container do carrossel, com os filhos na mesma ordem dos slides
      const params = { media_type: "CAROUSEL", children: filhos.join(",") };
      if (legenda) params.caption = legenda;
      const id = await pub.criarContainer(params);
      await pub.aguardarStatus(id, { timeoutMs: ctx.restanteMs() });
      return id;
    },
  },

  // Falta (ver README, "O que falta para Reels e Stories"):
  //   validar: 1 item com url de vídeo (MP4/MOV, https), legenda via
  //     validarLegenda, cover_url opcional (JPEG público), share_to_feed
  //     opcional (booleano)
  //   criarContainers: criarContainer({ media_type: "REELS", video_url,
  //     caption, cover_url?, share_to_feed? }) e aguardarStatus com timeout
  //     maior — vídeo leva minutos, não cabe num request de 60s; precisa de
  //     um GET de status separado (rascunho "processando").
  REELS: {
    implementado: false,
    descricao: "Reels (video_url, media_type=REELS, cover_url/share_to_feed opcionais)",
  },

  // Falta: validar 1 item com image_url (JPEG) OU video_url, sem legenda
  // (Stories não têm caption); criarContainer({ media_type: "STORIES",
  // image_url | video_url }); vídeo com o mesmo problema de tempo do Reels.
  STORIES: {
    implementado: false,
    descricao: "Stories (media_type=STORIES com image_url ou video_url)",
  },
};

// Resolve o tipo pedido. Desconhecido → 400; conhecido mas não pronto → 501.
export function tipoDefinido(tipo) {
  const nome = typeof tipo === "string" ? tipo.trim().toUpperCase() : "";
  const def = TIPOS[nome];
  if (!def) {
    throw new ErroHttp(400, `tipo "${tipo ?? ""}" desconhecido. Tipos: ${Object.keys(TIPOS).join(", ")}.`);
  }
  if (!def.implementado) {
    throw new ErroHttp(501, `tipo ${nome} ainda não implementado (${def.descricao}). Hoje só CAROUSEL.`);
  }
  return { nome, def };
}
