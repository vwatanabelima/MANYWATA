// Publicação de mídia (POST /api/midia/publicar, uma chamada só). Tudo com
// fetch falso: nenhum teste chama o Instagram de verdade.

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotaPublicar } from "../api/_lib/rotas-midia.js";
import { sanitizar, validarUrlPublica, ErroHttp } from "../api/_lib/seguranca.js";
import { TIPOS, validarLegenda, criarPublicador, emParalelo } from "../api/_lib/instagram-publicacao.js";
import {
  MAX_DURATION_S,
  ORCAMENTO_CONTAINERS_MS,
  STATUS_ESPERA_MINIMA_MS,
  CLI_TIMEOUT_ROTA_MS,
} from "../api/_lib/tempos.js";
import rotaMidiaPublicar from "../api/midia/publicar.js";
import aliasCarrossel from "../api/carrossel/publicar.js";
import { listarSlides, montarUrls, executar } from "../scripts/midia.mjs";
import {
  MAX_BYTES,
  carimbo,
  dimensoesJpeg,
  sanitizarSlug,
  slugDaPasta,
  lerCredenciaisStorage,
  enviarParaStorage,
  apagarDoStorage,
} from "../scripts/_storage.mjs";

const SEGREDO = "segredo-de-teste-com-bem-mais-de-32-caracteres";
const TOKEN = "token-falso-eterniza-midia-so-para-teste-0123456789";
const USER = "17841438494434121"; // @eternizacards
const ENV = { PUBLICAR_SECRET: SEGREDO, IG_ACCESS_TOKEN_ETERNIZA: TOKEN };
const T0 = Date.parse("2026-11-15T12:00:00.000Z");
const LEGENDA = "Sua carta, seu nome, seu ataque. #tcg #eternizacards";
const URLS = [
  "https://cdn.exemplo.com/render/slide-01.jpg",
  "https://cdn.exemplo.com/render/slide-02.jpg",
  "https://cdn.exemplo.com/render/slide-03.jpg",
];

// ── Fakes ─────────────────────────────────────────────────────────────────

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
  };
}

function fakeReq({ method = "POST", body, auth = `Bearer ${SEGREDO}` } = {}) {
  return {
    method,
    body,
    url: "/",
    headers: { host: "manywata.vercel.app", ...(auth ? { authorization: auth } : {}) },
  };
}

// Relógio falso com agenda (simulação de eventos discretos). sleep(ms) só
// resolve quando o tempo falso chega lá, e esperas em paralelo andam juntas
// (três sleeps de 2s em Promise.all levam 2s, não 6s). Ninguém espera de
// verdade: quando tudo que podia andar já andou (microtasks drenadas), o
// relógio pula pro próximo timer. `passar` é a mesma espera sem o espião,
// pros fakes simularem chamadas lentas sem contar como sleep da rota.
function relogio(inicio = T0) {
  const r = { t: inicio };
  const timers = [];
  let seq = 0;
  let agendado = false;
  const disparar = () => {
    agendado = false;
    if (!timers.length) return;
    timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const prox = timers.shift();
    r.t = Math.max(r.t, prox.at);
    prox.resolve();
    agendar();
  };
  const agendar = () => {
    if (!agendado && timers.length) {
      agendado = true;
      setImmediate(disparar);
    }
  };
  r.now = () => r.t;
  r.passar = (ms) =>
    new Promise((resolve) => {
      timers.push({ at: r.t + Math.max(0, ms), seq: seq++, resolve });
      agendar();
    });
  r.sleep = vi.fn((ms) => r.passar(ms));
  return r;
}

// Imita o Graph: cria containers com ids sequenciais (na ordem em que as
// respostas saem), status configurável. `demora(chamada)` → ms que a chamada
// leva no relógio falso `rel`; `falharSe(chamada)` → mensagem de erro do Meta.
// `permalink: null` imita mídia sem permalink (story): o Graph devolve só o id.
function meta({ status = () => "FINISHED", quota = 0, total = 50, falhar = {}, falharSe = () => null, demora, rel, permalink = "https://www.instagram.com/p/ABC123/" } = {}) {
  let proximo = 1000;
  const chamadas = [];
  const fetch = vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    const metodo = init.method || "GET";
    const caminho = u.pathname.replace(/^\/v21\.0\//, "");
    const params = metodo === "GET" ? Object.fromEntries(u.searchParams) : JSON.parse(init.body);
    const chamada = { metodo, caminho, params, url, headers: init.headers, em: rel?.t };
    chamadas.push(chamada);
    const ms = demora?.(chamada) ?? 0;
    if (ms > 0) await rel.passar(ms);
    const ok = (body, st = 200) => ({ ok: st < 400, status: st, json: async () => body });
    const chave = `${metodo} ${caminho}${params.fields ? `?${params.fields}` : ""}`;
    if (falhar[chave]) return ok({ error: { message: falhar[chave] } }, 400);
    const msg = falharSe(chamada);
    if (msg) return ok({ error: { message: msg } }, 400);

    if (metodo === "POST" && caminho === `${USER}/media`) {
      chamada.id = String(proximo++);
      return ok({ id: chamada.id });
    }
    if (metodo === "POST" && caminho === `${USER}/media_publish`) return ok({ id: "9001" });
    if (caminho === `${USER}/content_publishing_limit`) {
      return ok({ data: [{ quota_usage: quota, config: { quota_total: total } }] });
    }
    if (params.fields === "status_code,status") {
      const s = status(caminho);
      return ok({ id: caminho, status_code: s, status: s === "ERROR" ? "Error: Media download has failed" : s });
    }
    if (params.fields === "permalink") return ok(permalink ? { id: caminho, permalink } : { id: caminho });
    return ok({ error: { message: "rota não mockada" } }, 400);
  });
  return { fetch, chamadas };
}

const corpo = (extra = {}) => ({
  conta: "eterniza",
  tipo: "CAROUSEL",
  itens: URLS.map((url) => ({ url })),
  legenda: LEGENDA,
  confirmar: true,
  ...extra,
});

async function publicar({ body = corpo(), auth, method, ...opcoes } = {}) {
  const res = fakeRes();
  await rotaPublicar(fakeReq({ body, auth, method }), res, { env: ENV, ...relogio(), ...opcoes });
  return res;
}

const resumo = (chamadas) => chamadas.map((c) => `${c.metodo} ${c.caminho}`);
const publicou = (chamadas) => chamadas.some((c) => c.caminho.endsWith("media_publish"));
const criouContainer = (chamadas) => chamadas.some((c) => c.metodo === "POST" && c.caminho.endsWith("/media"));

// ── Autenticação e método (zero fetch) ────────────────────────────────────

describe("autenticação e método", () => {
  test("sem PUBLICAR_SECRET → 503 e zero fetch", async () => {
    const { fetch } = meta();
    const res = await publicar({ env: { IG_ACCESS_TOKEN_ETERNIZA: TOKEN }, fetch });
    expect(res.statusCode).toBe(503);
    expect(res.body.erro).toMatch(/PUBLICAR_SECRET/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("PUBLICAR_SECRET curto demais → 503 e zero fetch", async () => {
    const { fetch } = meta();
    const res = await publicar({ auth: "Bearer curto", env: { ...ENV, PUBLICAR_SECRET: "curto" }, fetch });
    expect(res.statusCode).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    ["sem header", null],
    ["segredo errado", "Bearer segredo-errado-com-bem-mais-de-32-caracteres!!"],
    ["Bearer vazio", "Bearer "],
    ["sem o prefixo Bearer", SEGREDO],
  ])("%s → 401 e zero fetch", async (_n, auth) => {
    const { fetch } = meta();
    const res = await publicar({ auth, fetch });
    expect(res.statusCode).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each(["GET", "PUT", "DELETE"])("%s → 405 com Allow: POST e zero fetch", async (method) => {
    const { fetch } = meta();
    const res = await publicar({ method, fetch });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("POST");
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── confirmar ─────────────────────────────────────────────────────────────

describe("confirmar precisa ser o booleano true", () => {
  test.each([
    ["ausente", { confirmar: undefined }],
    ["string 'true'", { confirmar: "true" }],
    ["número 1", { confirmar: 1 }],
    ["false", { confirmar: false }],
    ["'sim'", { confirmar: "sim" }],
  ])("confirmar %s → 400 e zero fetch", async (_n, extra) => {
    const { fetch } = meta();
    const res = await publicar({ body: corpo(extra), fetch });
    expect(res.statusCode).toBe(400);
    expect(res.body.erro).toMatch(/confirmar: true/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── Validação (antes de qualquer fetch) ───────────────────────────────────

describe("validação (400, zero fetch)", () => {
  const url = (i) => ({ url: `https://cdn.exemplo.com/s-${i}.jpg` });
  test.each([
    ["1 item", { itens: [url(1)] }, /2 a 10/],
    ["11 itens", { itens: Array.from({ length: 11 }, (_, i) => url(i)) }, /2 a 10/],
    ["itens não é lista", { itens: "a,b" }, /lista/],
    ["itens ausente", { itens: undefined }, /lista/],
    ["item sem url", { itens: [url(1), {}] }, /itens\[1\]\.url/],
    ["http", { itens: [url(1), { url: "http://cdn.exemplo.com/s.jpg" }] }, /https/],
    ["png", { itens: [url(1), { url: "https://cdn.exemplo.com/s.png" }] }, /JPEG/],
    ["localhost", { itens: [url(1), { url: "https://localhost/s.jpg" }] }, /não é público/],
    ["IP privado", { itens: [url(1), { url: "https://192.168.0.10/s.jpg" }] }, /não é público/],
    ["metadata de nuvem", { itens: [url(1), { url: "https://169.254.169.254/s.jpg" }] }, /não é público/],
    ["legenda longa", { legenda: "a".repeat(2201) }, /2201 caracteres/],
    ["31 hashtags", { legenda: Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ") }, /31 hashtags/],
    ["21 menções", { legenda: Array.from({ length: 21 }, (_, i) => `@user${i}`).join(" ") }, /21 menções/],
    ["legenda não é texto", { legenda: 123 }, /texto/],
    ["tipo desconhecido", { tipo: "FOTO" }, /desconhecido/],
    ["tipo ausente", { tipo: undefined }, /desconhecido/],
    ["conta inexistente", { conta: "naoexiste" }, /não existe/],
  ])("%s", async (_n, extra, msg) => {
    const { fetch } = meta();
    const res = await publicar({ body: corpo(extra), fetch });
    expect(res.statusCode).toBe(400);
    expect(res.body.erro).toMatch(msg);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("legenda com exatamente 2200 caracteres e 30 hashtags passa", () => {
    const tags = Array.from({ length: 30 }, (_, i) => `#t${i}`).join(" ");
    const texto = tags + " " + "a".repeat(2200 - tags.length - 1);
    expect(validarLegenda(texto)).toHaveLength(2200);
  });

  test("e-mail na legenda não conta como menção", () => {
    const emails = Array.from({ length: 25 }, (_, i) => `contato${i}@eterniza.com`).join(" ");
    expect(validarLegenda(emails)).toBe(emails);
  });

  test.each([
    ["não é JSON", "{nao é json"],
    ["é uma lista", [corpo()]],
    ["vazio", null],
    ["string vazia", ""],
  ])("corpo %s → 400 e zero fetch", async (_n, body) => {
    const { fetch } = meta();
    const res = await publicar({ body, fetch });
    expect(res.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("corpo como string JSON é aceito", async () => {
    const { fetch } = meta();
    const res = await publicar({ body: JSON.stringify(corpo()), fetch });
    expect(res.statusCode).toBe(200);
  });

  test("token da conta ausente → 503 claro e zero fetch", async () => {
    const { fetch } = meta();
    const res = await publicar({ env: { PUBLICAR_SECRET: SEGREDO }, fetch });
    expect(res.statusCode).toBe(503);
    expect(res.body.erro).toMatch(/IG_ACCESS_TOKEN_ETERNIZA/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each(["REELS", "reels"])("tipo %s → 501 e zero fetch", async (tipo) => {
    const { fetch } = meta();
    const res = await publicar({ body: corpo({ tipo }), fetch });
    expect(res.statusCode).toBe(501);
    expect(res.body.erro).toMatch(/não implementado/);
    expect(res.body.erro).toMatch(/Hoje: CAROUSEL, STORIES/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("registro de tipos: CAROUSEL e STORIES implementados, REELS não", () => {
    expect(Object.keys(TIPOS)).toEqual(["CAROUSEL", "REELS", "STORIES"]);
    expect(TIPOS.CAROUSEL.implementado).toBe(true);
    expect(TIPOS.REELS.implementado).toBe(false);
    expect(TIPOS.STORIES.implementado).toBe(true);
  });
});

// ── Limite de 24h (antes de criar container) ──────────────────────────────

describe("limite de publicação", () => {
  test("cota atingida → 429 sem criar nenhum container", async () => {
    const { fetch, chamadas } = meta({ quota: 50, total: 50 });
    const res = await publicar({ fetch });
    expect(res.statusCode).toBe(429);
    expect(res.body.erro).toMatch(/50\/50/);
    expect(resumo(chamadas)).toEqual([`GET ${USER}/content_publishing_limit`]);
    expect(criouContainer(chamadas)).toBe(false);
    expect(publicou(chamadas)).toBe(false);
  });

  test("sem quota_total usa 50 como padrão", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ quota_usage: 50 }] }) }));
    const res = await publicar({ fetch });
    expect(res.statusCode).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("não deu pra ler a cota → 502 (falha fechada) sem criar container", async () => {
    const { fetch, chamadas } = meta({ falhar: { [`GET ${USER}/content_publishing_limit?quota_usage,config`]: "indisponível" } });
    const res = await publicar({ fetch });
    expect(res.statusCode).toBe(502);
    expect(criouContainer(chamadas)).toBe(false);
  });

  test("cota com resposta sem quota_usage → 502 sem criar container", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));
    const res = await publicar({ fetch });
    expect(res.statusCode).toBe(502);
    expect(res.body.erro).toMatch(/limite de publicação/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ── Fluxo feliz ───────────────────────────────────────────────────────────

describe("fluxo feliz", () => {
  test("limite → filhos na ordem → FINISHED → CAROUSEL → FINISHED → media_publish → permalink", async () => {
    const { fetch, chamadas } = meta({ quota: 3 });
    const res = await publicar({ fetch });

    expect(res.statusCode).toBe(200);
    expect(resumo(chamadas)).toEqual([
      `GET ${USER}/content_publishing_limit`,
      `POST ${USER}/media`,
      `POST ${USER}/media`,
      `POST ${USER}/media`,
      "GET 1000",
      "GET 1001",
      "GET 1002",
      `POST ${USER}/media`,
      "GET 1003",
      `POST ${USER}/media_publish`,
      "GET 9001",
    ]);
    expect(chamadas[0].params.fields).toBe("quota_usage,config");
    // filhos: is_carousel_item + image_url na ordem dos slides
    expect(chamadas.slice(1, 4).map((c) => c.params)).toEqual(
      URLS.map((url) => ({ image_url: url, is_carousel_item: true }))
    );
    // carrossel: children na mesma ordem, com legenda
    expect(chamadas[7].params).toEqual({ media_type: "CAROUSEL", children: "1000,1001,1002", caption: LEGENDA });
    expect(chamadas[9].params).toEqual({ creation_id: "1003" });
    expect(chamadas[10].params.fields).toBe("permalink");
    // token só no header, nunca na URL
    for (const c of chamadas) {
      expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.url).not.toContain("access_token");
      expect(c.url).not.toContain(TOKEN);
      expect(c.url.startsWith("https://graph.instagram.com/v21.0/")).toBe(true);
    }

    expect(res.body).toEqual({
      mediaId: "9001",
      permalink: "https://www.instagram.com/p/ABC123/",
      username: "eternizacards",
      quota: { usado: 4, total: 50 },
      conta: "eterniza",
      tipo: "CAROUSEL",
    });
  });

  test("tipo em minúsculas e legenda vazia: publica sem caption", async () => {
    const { fetch, chamadas } = meta();
    const res = await publicar({ body: corpo({ tipo: "carousel", legenda: "   " }), fetch });
    expect(res.statusCode).toBe(200);
    const carrossel = chamadas.find((c) => c.params.media_type === "CAROUSEL");
    expect(carrossel.params).not.toHaveProperty("caption");
  });

  test("legenda com \\r\\n é normalizada e aparada", async () => {
    const { fetch, chamadas } = meta();
    await publicar({ body: corpo({ legenda: "  linha 1\r\nlinha 2\n\n" }), fetch });
    const carrossel = chamadas.find((c) => c.params.media_type === "CAROUSEL");
    expect(carrossel.params.caption).toBe("linha 1\nlinha 2");
  });

  test("container IN_PROGRESS que termina depois: espera com sleep falso e publica", async () => {
    let vezes = 0;
    const { fetch, chamadas } = meta({ status: (id) => (id === "1003" && vezes++ < 2 ? "IN_PROGRESS" : "FINISHED") });
    const rel = relogio();
    const res = await publicar({ fetch, ...rel, intervaloMs: 1000 });
    expect(res.statusCode).toBe(200);
    expect(rel.sleep).toHaveBeenCalledTimes(2);
    expect(chamadas.filter((c) => c.caminho === "1003")).toHaveLength(3);
  });
});

// ── Falhas no Instagram ───────────────────────────────────────────────────

describe("falhas no Instagram", () => {
  test("filho com status ERROR → 502 claro, sem CAROUSEL e sem media_publish", async () => {
    const { fetch, chamadas } = meta({ status: (id) => (id === "1001" ? "ERROR" : "FINISHED") });
    const res = await publicar({ fetch });
    expect(res.statusCode).toBe(502);
    expect(res.body.erro).toMatch(/1001.*ERROR/);
    expect(res.body.erro).toMatch(/JPEG/);
    expect(chamadas.some((c) => c.params.media_type === "CAROUSEL")).toBe(false);
    expect(publicou(chamadas)).toBe(false);
  });

  test("container CAROUSEL com status ERROR → 502 sem media_publish", async () => {
    const { fetch, chamadas } = meta({ status: (id) => (id === "1003" ? "ERROR" : "FINISHED") });
    const res = await publicar({ fetch });
    expect(res.statusCode).toBe(502);
    expect(publicou(chamadas)).toBe(false);
  });

  test("status IN_PROGRESS para sempre → 504 dentro do orçamento, sem esperar de verdade e sem publicar", async () => {
    const { fetch, chamadas } = meta({ status: () => "IN_PROGRESS" });
    const rel = relogio();
    const res = await publicar({ fetch, ...rel, orcamentoMs: 10_000, intervaloMs: 2_000 });
    expect(res.statusCode).toBe(504);
    expect(res.body.erro).toMatch(/não ficou pronto/);
    expect(rel.t - T0).toBeLessThanOrEqual(10_000);
    expect(rel.sleep).toHaveBeenCalled();
    expect(publicou(chamadas)).toBe(false);
  });

  // Antes: "cabe nos 60s da função" com orçamento de 45s. Agora a função tem
  // MAX_DURATION_S (300s) e o orçamento é ORCAMENTO_CONTAINERS_MS (240s).
  test("orçamento padrão: espera o orçamento inteiro e ainda cabe no maxDuration com folga", async () => {
    const { fetch, chamadas } = meta({ status: () => "IN_PROGRESS" });
    const rel = relogio();
    const res = await publicar({ fetch, ...rel });
    expect(res.statusCode).toBe(504);
    expect(res.body.publicado).toBe(false);
    expect(rel.t - T0).toBeGreaterThanOrEqual(ORCAMENTO_CONTAINERS_MS);
    expect(rel.t - T0).toBeLessThanOrEqual(MAX_DURATION_S * 1000 - 30_000);
    expect(publicou(chamadas)).toBe(false);
  });

  test("504 de timeout: mensagem com o tempo real e o último status, nunca negativa", async () => {
    const { fetch } = meta({ status: () => "IN_PROGRESS" });
    const rel = relogio();
    const res = await publicar({ fetch, ...rel, orcamentoMs: 10_000 });
    expect(res.statusCode).toBe(504);
    expect(res.body.erro).toMatch(/slide \d de 3: container \d+ não ficou pronto em 10s \(último status: IN_PROGRESS\)/);
    expect(res.body.erro).not.toMatch(/em -?0s|em -\d/);
    expect(res.body.publicado).toBe(false);
  });

  test("container EXPIRED → 410 sem publicar", async () => {
    const { fetch, chamadas } = meta({ status: () => "EXPIRED" });
    const res = await publicar({ fetch });
    expect(res.statusCode).toBe(410);
    expect(publicou(chamadas)).toBe(false);
  });

  test("Graph recusa a criação → 502 com a mensagem do Meta", async () => {
    const { fetch, chamadas } = meta({ falhar: { [`POST ${USER}/media`]: "Only photo or video can be accepted as media type." } });
    const res = await publicar({ fetch });
    expect(res.statusCode).toBe(502);
    expect(res.body.erro).toMatch(/Only photo or video/);
    expect(publicou(chamadas)).toBe(false);
  });

  test("media_publish recusado → 502", async () => {
    const { fetch } = meta({ falhar: { [`POST ${USER}/media_publish`]: "Fatal" } });
    const res = await publicar({ fetch });
    expect(res.statusCode).toBe(502);
    expect(res.body.erro).toMatch(/media_publish.*Fatal/);
  });

  test("permalink falhou depois de publicar → 200 com aviso (não induz republicar)", async () => {
    const { fetch } = meta({ falhar: { "GET 9001?permalink": "temporariamente indisponível" } });
    const res = await publicar({ fetch });
    expect(res.statusCode).toBe(200);
    expect(res.body.mediaId).toBe("9001");
    expect(res.body.permalink).toBeNull();
    expect(res.body.aviso).toMatch(/permalink/);
    expect(res.body.aviso).toMatch(/NÃO publique de novo/);
  });
});

// ── STORIES (1 imagem JPEG, sem legenda) ──────────────────────────────────

describe("STORIES", () => {
  const URL_STORY = "https://cdn.exemplo.com/stories/promo-natal.jpg";
  const corpoStory = (extra = {}) => ({
    conta: "eterniza",
    tipo: "STORIES",
    itens: [{ url: URL_STORY }],
    confirmar: true,
    ...extra,
  });

  test("feliz: limite → container STORIES → FINISHED → media_publish → permalink", async () => {
    const { fetch, chamadas } = meta({ quota: 7 });
    const res = await publicar({ body: corpoStory(), fetch });

    expect(res.statusCode).toBe(200);
    expect(resumo(chamadas)).toEqual([
      `GET ${USER}/content_publishing_limit`,
      `POST ${USER}/media`,
      "GET 1000",
      `POST ${USER}/media_publish`,
      "GET 9001",
    ]);
    // params EXATOS: sem caption, sem is_carousel_item, sem children
    expect(chamadas[1].params).toEqual({ image_url: URL_STORY, media_type: "STORIES" });
    expect(chamadas[1].params).not.toHaveProperty("caption");
    expect(chamadas[1].params).not.toHaveProperty("is_carousel_item");
    expect(chamadas[2].params.fields).toBe("status_code,status");
    expect(chamadas[3].params).toEqual({ creation_id: "1000" });
    for (const c of chamadas) {
      expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.url).not.toContain(TOKEN);
    }
    expect(res.body).toEqual({
      mediaId: "9001",
      permalink: "https://www.instagram.com/p/ABC123/",
      username: "eternizacards",
      quota: { usado: 8, total: 50 },
      conta: "eterniza",
      tipo: "STORIES",
    });
  });

  test("tipo em minúsculas funciona", async () => {
    const { fetch } = meta();
    const res = await publicar({ body: corpoStory({ tipo: "stories" }), fetch });
    expect(res.statusCode).toBe(200);
    expect(res.body.tipo).toBe("STORIES");
  });

  test("sem permalink no Graph → 200 com mediaId, permalink null e SEM aviso", async () => {
    const { fetch } = meta({ permalink: null });
    const res = await publicar({ body: corpoStory(), fetch });
    expect(res.statusCode).toBe(200);
    expect(res.body.mediaId).toBe("9001");
    expect(res.body.permalink).toBeNull();
    expect(res.body).not.toHaveProperty("aviso");
  });

  test("GET do permalink falha depois de publicar → 200 sem aviso (story não precisa de permalink)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetch } = meta({ falhar: { "GET 9001?permalink": "Unsupported get request" } });
    const res = await publicar({ body: corpoStory(), fetch });
    expect(res.statusCode).toBe(200);
    expect(res.body.mediaId).toBe("9001");
    expect(res.body.permalink).toBeNull();
    expect(res.body).not.toHaveProperty("aviso");
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });

  test.each([
    ["2 itens", { itens: [{ url: URL_STORY }, { url: URL_STORY }] }, /exatamente 1 item \(veio 2\)/],
    ["0 itens", { itens: [] }, /exatamente 1 item \(veio 0\)/],
    ["itens não é lista", { itens: URL_STORY }, /lista/],
    ["legenda", { legenda: "Promo de Natal!" }, /story não tem legenda/],
    ["legenda que não é texto", { legenda: 123 }, /story não tem legenda/],
    ["png", { itens: [{ url: "https://cdn.exemplo.com/s.png" }] }, /só aceita JPEG/],
    ["webp", { itens: [{ url: "https://cdn.exemplo.com/s.webp" }] }, /só aceita JPEG/],
    ["http", { itens: [{ url: "http://cdn.exemplo.com/s.jpg" }] }, /https/],
    ["IP privado", { itens: [{ url: "https://10.0.0.5/s.jpg" }] }, /não é público/],
    ["item sem url", { itens: [{}] }, /itens\[0\]\.url/],
  ])("%s → 400 e zero fetch", async (_n, extra, msg) => {
    const { fetch } = meta();
    const res = await publicar({ body: corpoStory(extra), fetch });
    expect(res.statusCode).toBe(400);
    expect(res.body.erro).toMatch(msg);
    expect(res.body.publicado).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([["ausente", undefined], ["null", null], ["vazia", ""], ["só espaços", "  \n "]])(
    "legenda %s é aceita e não vira caption",
    async (_n, legenda) => {
      const { fetch, chamadas } = meta();
      const res = await publicar({ body: corpoStory({ legenda }), fetch });
      expect(res.statusCode).toBe(200);
      const container = chamadas.find((c) => c.metodo === "POST" && c.caminho === `${USER}/media`);
      expect(container.params).toEqual({ image_url: URL_STORY, media_type: "STORIES" });
    }
  );

  test.each([
    ["URL .mp4", { itens: [{ url: "https://cdn.exemplo.com/s.mp4" }] }],
    ["URL .MOV", { itens: [{ url: "https://cdn.exemplo.com/s.MOV" }] }],
    ["campo video_url", { itens: [{ video_url: "https://cdn.exemplo.com/s.mp4" }] }],
  ])("story de vídeo (%s) → 501 e zero fetch", async (_n, extra) => {
    const { fetch } = meta();
    const res = await publicar({ body: corpoStory(extra), fetch });
    expect(res.statusCode).toBe(501);
    expect(res.body.erro).toMatch(/story de vídeo ainda não implementado/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("REELS continua 501", async () => {
    const { fetch } = meta();
    const res = await publicar({ body: corpoStory({ tipo: "REELS" }), fetch });
    expect(res.statusCode).toBe(501);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("sem PUBLICAR_SECRET → 503 e zero fetch", async () => {
    const { fetch } = meta();
    const res = await publicar({ body: corpoStory(), env: { IG_ACCESS_TOKEN_ETERNIZA: TOKEN }, fetch });
    expect(res.statusCode).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("token da conta ausente → 503 e zero fetch", async () => {
    const { fetch } = meta();
    const res = await publicar({ body: corpoStory(), env: { PUBLICAR_SECRET: SEGREDO }, fetch });
    expect(res.statusCode).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([["sem header", null], ["segredo errado", "Bearer segredo-errado-com-bem-mais-de-32-caracteres!!"]])(
    "%s → 401 e zero fetch",
    async (_n, auth) => {
      const { fetch } = meta();
      const res = await publicar({ body: corpoStory(), auth, fetch });
      expect(res.statusCode).toBe(401);
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  test.each([["ausente", undefined], ["string 'true'", "true"], ["1", 1]])("confirmar %s → 400 e zero fetch", async (_n, confirmar) => {
    const { fetch } = meta();
    const res = await publicar({ body: corpoStory({ confirmar }), fetch });
    expect(res.statusCode).toBe(400);
    expect(res.body.erro).toMatch(/confirmar: true/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("cota cheia → 429 sem criar container", async () => {
    const { fetch, chamadas } = meta({ quota: 50, total: 50 });
    const res = await publicar({ body: corpoStory(), fetch });
    expect(res.statusCode).toBe(429);
    expect(res.body.publicado).toBe(false);
    expect(resumo(chamadas)).toEqual([`GET ${USER}/content_publishing_limit`]);
    expect(criouContainer(chamadas)).toBe(false);
  });

  test("container STORIES com ERROR → 502 sem media_publish, publicado: false", async () => {
    const { fetch, chamadas } = meta({ status: () => "ERROR" });
    const res = await publicar({ body: corpoStory(), fetch });
    expect(res.statusCode).toBe(502);
    expect(res.body.publicado).toBe(false);
    expect(publicou(chamadas)).toBe(false);
  });

  test("container IN_PROGRESS para sempre → 504 sem publicar", async () => {
    const { fetch, chamadas } = meta({ status: () => "IN_PROGRESS" });
    const res = await publicar({ body: corpoStory(), fetch, orcamentoMs: 10_000 });
    expect(res.statusCode).toBe(504);
    expect(res.body.publicado).toBe(false);
    expect(publicou(chamadas)).toBe(false);
  });

  test("media_publish recusado → 502 sem o campo publicado (indefinido)", async () => {
    const { fetch } = meta({ falhar: { [`POST ${USER}/media_publish`]: "Fatal" } });
    const res = await publicar({ body: corpoStory(), fetch });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toHaveProperty("publicado");
  });

  test("carrossel continua com aviso quando o permalink falha (só STORIES é opcional)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetch } = meta({ falhar: { "GET 9001?permalink": "indisponível" } });
    const res = await publicar({ fetch });
    expect(res.body.aviso).toMatch(/NÃO publique de novo/);
    warn.mockRestore();
  });
});

// ── Criação lenta e paralelismo (bug de 2026-11-15) ───────────────────────
//
// Produção: carrossel de 9 slides deu 504 "não ficou pronto em 0s" / "em -2s".
// Os 9 POST /media eram em sequência, cada um levando segundos (o Meta baixa
// a imagem antes de responder), e comiam o orçamento de 45s inteiro.

describe("carrossel com criação lenta", () => {
  const NOVE = Array.from({ length: 9 }, (_, i) => `https://cdn.exemplo.com/render/slide-${String(i + 1).padStart(2, "0")}.jpg`);
  const corpo9 = () => corpo({ itens: NOVE.map((url) => ({ url })) });
  const postMedia = (c) => c.metodo === "POST" && c.caminho === `${USER}/media`;
  const filhos = (chamadas) => chamadas.filter((c) => postMedia(c) && c.params.is_carousel_item);

  // Padrão e o orçamento antigo (45s): em paralelo, os dois passam.
  test.each([
    ["orçamento padrão", undefined],
    ["orçamento antigo de 45s", 45_000],
  ])("9 slides, cada POST /media demorando 6s → publica (%s)", async (_n, orcamentoMs) => {
    const rel = relogio();
    const { fetch, chamadas } = meta({ rel, demora: (c) => (postMedia(c) ? 6_000 : 0) });
    const res = await publicar({ body: corpo9(), fetch, ...rel, ...(orcamentoMs ? { orcamentoMs } : {}) });

    expect(res.statusCode).toBe(200);
    expect(res.body.mediaId).toBe("9001");
    // os 9 filhos saíram juntos, no mesmo instante
    expect(filhos(chamadas)).toHaveLength(9);
    expect(new Set(filhos(chamadas).map((c) => c.em))).toEqual(new Set([T0]));
    // 6s dos filhos + 6s do CAROUSEL; em sequência seriam 54s + 6s
    expect(rel.t - T0).toBe(12_000);
    // nenhum aguardarStatus precisou dormir (já estavam FINISHED)
    expect(rel.sleep).not.toHaveBeenCalled();
  });

  test("children na ordem dos slides mesmo com as respostas chegando fora de ordem", async () => {
    const rel = relogio();
    // slide 1 é o mais lento, slide 9 o mais rápido → ids saem invertidos
    const demora = (c) => (postMedia(c) && c.params.is_carousel_item ? (10 - NOVE.indexOf(c.params.image_url)) * 1_000 : 0);
    const { fetch, chamadas } = meta({ rel, demora });
    const res = await publicar({ body: corpo9(), fetch, ...rel });

    expect(res.statusCode).toBe(200);
    const idPorUrl = Object.fromEntries(filhos(chamadas).map((c) => [c.params.image_url, c.id]));
    expect(idPorUrl[NOVE[0]]).toBe("1008"); // o último a responder
    expect(idPorUrl[NOVE[8]]).toBe("1000"); // o primeiro a responder
    const carrossel = chamadas.find((c) => c.params.media_type === "CAROUSEL");
    expect(carrossel.params.children).toBe(NOVE.map((u) => idPorUrl[u]).join(","));
    expect(carrossel.params.children).toBe("1008,1007,1006,1005,1004,1003,1002,1001,1000");
  });

  test("um filho recusado na criação → erro com o número do slide, sem CAROUSEL nem publish", async () => {
    const rel = relogio();
    const { fetch, chamadas } = meta({
      rel,
      demora: (c) => (postMedia(c) ? 3_000 : 0),
      falharSe: (c) => (c.params.image_url === NOVE[4] ? "Only photo or video can be accepted as media type." : null),
    });
    const res = await publicar({ body: corpo9(), fetch, ...rel });
    expect(res.statusCode).toBe(502);
    expect(res.body.erro).toMatch(/^slide 5 de 9: Instagram recusou POST .*Only photo or video/);
    expect(res.body.publicado).toBe(false);
    expect(chamadas.some((c) => c.params.media_type === "CAROUSEL")).toBe(false);
    expect(publicou(chamadas)).toBe(false);
  });

  test("filho com ERROR cancela a espera dos outros e nada fica rodando depois da resposta", async () => {
    const rel = relogio();
    const { fetch, chamadas } = meta({ rel, status: (id) => (id === "1001" ? "ERROR" : "IN_PROGRESS") });
    const res = await publicar({ fetch, ...rel });
    expect(res.statusCode).toBe(502);
    expect(res.body.erro).toMatch(/^slide 2 de 3: container 1001 falhou no Instagram \(ERROR\)/);
    expect(res.body.publicado).toBe(false);
    // não esperou o orçamento: parou na volta seguinte do polling
    expect(rel.t - T0).toBeLessThanOrEqual(5_000);
    const total = chamadas.length;
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(chamadas.length).toBe(total);
    expect(publicou(chamadas)).toBe(false);
  });

  test("emParalelo devolve na ordem das tarefas, não na de conclusão", async () => {
    const rel = relogio();
    const r = await emParalelo([3, 1, 2].map((s) => () => rel.passar(s * 1000).then(() => s)));
    expect(r).toEqual([3, 1, 2]);
    expect(rel.t - T0).toBe(3_000);
  });
});

// ── aguardarStatus ────────────────────────────────────────────────────────

describe("aguardarStatus", () => {
  // Graph falso só pro GET de status; `lento` = ms que cada GET leva.
  function cliente({ statuses = () => "IN_PROGRESS", lento = 0 } = {}) {
    const rel = relogio();
    let n = 0;
    const fetch = vi.fn(async () => {
      if (lento) await rel.passar(lento);
      const s = statuses(n++);
      return { ok: true, status: 200, json: async () => ({ status_code: s }) };
    });
    const pub = criarPublicador({ userId: USER, token: TOKEN, fetch, sleep: rel.sleep, now: rel.now });
    return { pub, fetch, rel };
  }

  test.each([0, -2_000])("orçamento %i: ainda checa de verdade, espera o mínimo e só então desiste", async (timeoutMs) => {
    const { pub, fetch, rel } = cliente();
    const e = await pub.aguardarStatus("555", { timeoutMs }).catch((x) => x);
    expect(e).toBeInstanceOf(ErroHttp);
    expect(e.status).toBe(504);
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(rel.t - T0).toBeGreaterThanOrEqual(STATUS_ESPERA_MINIMA_MS);
    expect(e.message).toBe("container 555 não ficou pronto em 10s (último status: IN_PROGRESS). Nada foi publicado.");
  });

  test("orçamento 0 mas fica FINISHED na 2ª checagem → resolve", async () => {
    const { pub, fetch, rel } = cliente({ statuses: (n) => (n === 0 ? "IN_PROGRESS" : "FINISHED") });
    await expect(pub.aguardarStatus("555", { timeoutMs: 0 })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(rel.sleep).toHaveBeenCalledTimes(1);
  });

  test("já FINISHED na primeira checagem: uma GET e nenhum sleep", async () => {
    const { pub, fetch, rel } = cliente({ statuses: () => "FINISHED" });
    await pub.aguardarStatus("555", { timeoutMs: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rel.sleep).not.toHaveBeenCalled();
  });

  test("mensagem usa o tempo REAL decorrido (GET lento de 4s), não o orçamento", async () => {
    const { pub, fetch } = cliente({ lento: 4_000 });
    const e = await pub.aguardarStatus("555", { timeoutMs: 0 }).catch((x) => x);
    // 0→4 GET, dorme 2 → 6, GET → 10 (2 checagens), dorme 3 → 13, GET → 17
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(e.message).toMatch(/não ficou pronto em 17s \(último status: IN_PROGRESS\)/);
  });

  test("polling começa em 2s e cresce até 5s, sem passar do orçamento", async () => {
    const { pub, rel } = cliente();
    const e = await pub.aguardarStatus("555", { timeoutMs: 30_000 }).catch((x) => x);
    const sonos = rel.sleep.mock.calls.map(([ms]) => ms);
    expect(sonos.slice(0, 4)).toEqual([2_000, 3_000, 4_500, 5_000]);
    expect(Math.max(...sonos)).toBe(5_000);
    expect(rel.t - T0).toBe(30_000);
    expect(e.message).toMatch(/em 30s/);
  });

  test("status sem status_code: mensagem diz 'desconhecido'", async () => {
    const { pub } = cliente({ statuses: () => undefined });
    const e = await pub.aguardarStatus("555", { timeoutMs: 0 }).catch((x) => x);
    expect(e.message).toMatch(/último status: desconhecido/);
  });
});

// ── publicado: false ──────────────────────────────────────────────────────

describe("campo publicado nas respostas de erro", () => {
  test.each([
    ["400 de validação", { body: corpo({ confirmar: false }) }, 400],
    ["429 de cota", { fetch: meta({ quota: 50 }).fetch }, 429],
    ["502 de container ERROR", { fetch: meta({ status: () => "ERROR" }).fetch }, 502],
    ["504 de timeout", { fetch: meta({ status: () => "IN_PROGRESS" }).fetch, orcamentoMs: 5_000 }, 504],
  ])("%s → publicado: false (media_publish nunca chamado)", async (_n, opcoes, status) => {
    const res = await publicar({ fetch: meta().fetch, ...opcoes });
    expect(res.statusCode).toBe(status);
    expect(res.body.publicado).toBe(false);
  });

  test("media_publish chamado e recusado → sem o campo publicado (resultado indefinido)", async () => {
    const res = await publicar({ fetch: meta({ falhar: { [`POST ${USER}/media_publish`]: "Fatal" } }).fetch });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toHaveProperty("publicado");
  });

  test("media_publish com falha de rede → sem o campo publicado", async () => {
    const { fetch: base } = meta();
    const fetch = vi.fn(async (url, init) => {
      if (url.endsWith("/media_publish")) throw new TypeError("fetch failed");
      return base(url, init);
    });
    const res = await publicar({ fetch });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toHaveProperty("publicado");
  });
});

// ── Tempos (vercel.json ↔ api/_lib/tempos.js) ─────────────────────────────

describe("tempos", () => {
  test("vercel.json usa MAX_DURATION_S nas duas rotas de mídia", () => {
    const cfg = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    expect(cfg.functions["api/midia/*.js"].maxDuration).toBe(MAX_DURATION_S);
    expect(cfg.functions["api/carrossel/*.js"].maxDuration).toBe(MAX_DURATION_S);
  });

  test("orçamento + duas esperas mínimas + 30s de folga cabem no maxDuration; CLI espera mais que a função", () => {
    expect(ORCAMENTO_CONTAINERS_MS + 2 * STATUS_ESPERA_MINIMA_MS + 30_000).toBeLessThanOrEqual(MAX_DURATION_S * 1000);
    expect(CLI_TIMEOUT_ROTA_MS).toBeGreaterThan(MAX_DURATION_S * 1000);
  });
});

// ── Arquivos de rota de verdade (process.env + fetch global) ──────────────

describe("arquivos de rota", () => {
  beforeEach(() => {
    vi.stubEnv("PUBLICAR_SECRET", SEGREDO);
    vi.stubEnv("IG_ACCESS_TOKEN_ETERNIZA", TOKEN);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("/api/midia/publicar publica", async () => {
    const { fetch } = meta();
    vi.stubGlobal("fetch", fetch);
    const res = fakeRes();
    await rotaMidiaPublicar(fakeReq({ body: corpo() }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.tipo).toBe("CAROUSEL");
  });

  test("/api/carrossel/publicar sem 'tipo' assume CAROUSEL", async () => {
    const { fetch } = meta();
    vi.stubGlobal("fetch", fetch);
    const res = fakeRes();
    await aliasCarrossel(fakeReq({ body: corpo({ tipo: undefined }) }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.tipo).toBe("CAROUSEL");
  });

  test("/api/midia/publicar publica STORIES", async () => {
    const { fetch, chamadas } = meta();
    vi.stubGlobal("fetch", fetch);
    const res = fakeRes();
    await rotaMidiaPublicar(
      fakeReq({ body: { conta: "eterniza", tipo: "STORIES", itens: [{ url: URLS[0] }], confirmar: true } }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.tipo).toBe("STORIES");
    expect(chamadas[1].params).toEqual({ image_url: URLS[0], media_type: "STORIES" });
  });

  test.each(["REELS", "STORIES"])("/api/carrossel/publicar com tipo %s → 400 e zero fetch", async (tipo) => {
    const { fetch } = meta();
    vi.stubGlobal("fetch", fetch);
    const res = fakeRes();
    await aliasCarrossel(fakeReq({ body: corpo({ tipo, itens: [{ url: URLS[0] }], legenda: undefined }) }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.erro).toMatch(/só aceita tipo CAROUSEL/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("/api/carrossel/publicar também exige confirmar: true", async () => {
    const { fetch } = meta();
    vi.stubGlobal("fetch", fetch);
    const res = fakeRes();
    await aliasCarrossel(fakeReq({ body: corpo({ confirmar: "true" }) }), res);
    expect(res.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── Token nunca vaza ──────────────────────────────────────────────────────

describe("o access token nunca aparece em resposta, erro ou log", () => {
  let espioes;
  beforeEach(() => {
    espioes = ["log", "warn", "error", "info", "debug"].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  });
  afterEach(() => vi.restoreAllMocks());

  const tudoQueFoiLogado = () => espioes.flatMap((s) => s.mock.calls.flat()).map(String).join("\n");

  test("fluxos feliz e de erro, inclusive com o Graph ecoando o token", async () => {
    const eco = `Invalid OAuth access token - https://graph.instagram.com/x?access_token=${TOKEN} (token ${TOKEN}) Bearer ${TOKEN}`;
    const respostas = [];
    const com = async (fetch) => respostas.push(await publicar({ fetch }));

    await com(meta().fetch); // feliz
    await com(meta({ falhar: { [`POST ${USER}/media`]: eco } }).fetch);
    await com(meta({ falhar: { [`POST ${USER}/media_publish`]: eco } }).fetch);
    await com(meta({ falhar: { "GET 9001?permalink": eco } }).fetch); // 200 com aviso
    await com(meta({ falhar: { [`GET ${USER}/content_publishing_limit?quota_usage,config`]: eco } }).fetch);
    await com(vi.fn(async () => { throw new TypeError(`fetch failed: ${eco}`); })); // rede
    await com(vi.fn(async () => ({ // erro inesperado (não-ErroHttp) carregando o token
      status: 200,
      json: async () => ({}),
      get ok() { throw new Error(`explodiu com ${TOKEN}`); },
    })));

    expect(respostas.map((r) => r.statusCode)).toEqual([200, 502, 502, 200, 502, 502, 500]);
    expect(respostas[1].body.erro).toContain("access_token=[oculto]");
    expect(respostas[3].body.aviso).toContain("[oculto]");
    expect(respostas[6].body.erro).toMatch(/erro interno/);
    for (const r of respostas) {
      const texto = JSON.stringify(r.body);
      expect(texto).not.toContain(TOKEN);
      expect(texto).not.toContain(SEGREDO);
    }
    const logado = tudoQueFoiLogado();
    expect(logado.length).toBeGreaterThan(0);
    expect(logado).not.toContain(TOKEN);
    expect(logado).not.toContain(SEGREDO);
  });

  test("sanitizar remove access_token, Bearer e segredos conhecidos", () => {
    const s = sanitizar(`GET /me?access_token=abc123&x=1 Authorization: Bearer xyz ${TOKEN}`, [TOKEN]);
    expect(s).toBe("GET /me?access_token=[oculto]&x=1 Authorization: Bearer [oculto] [oculto]");
  });
});

// ── URLs ──────────────────────────────────────────────────────────────────

describe("validarUrlPublica", () => {
  test.each([
    "https://cdn.exemplo.com/a.jpg",
    "https://eternizacards.com.br/render/slide-01.jpg",
    "https://8.8.8.8/a.jpg",
  ])("aceita %s", (url) => {
    expect(validarUrlPublica(url)).toBe(url);
  });

  test.each([
    "http://cdn.exemplo.com/a.jpg",
    "ftp://cdn.exemplo.com/a.jpg",
    "https://localhost/a.jpg",
    "https://app.localhost/a.jpg",
    "https://127.0.0.1/a.jpg",
    "https://2130706433/a.jpg", // 127.0.0.1 disfarçado
    "https://10.0.0.5/a.jpg",
    "https://172.20.1.1/a.jpg",
    "https://192.168.1.1/a.jpg",
    "https://169.254.169.254/latest",
    "https://[::1]/a.jpg",
    "https://[fd00::1]/a.jpg",
    "https://intranet/a.jpg",
    "https://user:senha@cdn.exemplo.com/a.jpg",
    "não é url",
    undefined,
  ])("recusa %s", (url) => {
    expect(() => validarUrlPublica(url)).toThrow(ErroHttp);
  });
});

// ── CLI ───────────────────────────────────────────────────────────────────

describe("scripts/midia.mjs", () => {
  let pasta;
  beforeEach(() => {
    pasta = mkdtempSync(join(tmpdir(), "render-"));
    for (const nome of ["slide-10.jpg", "slide-2.jpg", "slide-01.jpg", "capa.png", "slide-03.png"]) {
      writeFileSync(join(pasta, nome), "");
    }
    writeFileSync(join(pasta, "instagram-post.txt"), `${LEGENDA}\n`);
  });
  afterEach(() => rmSync(pasta, { recursive: true, force: true }));

  // Nunca lê o .env.local de verdade nos testes.
  const vars = (extra = {}) => (nome) => ({ PUBLICAR_SECRET: SEGREDO, MANYWATA_URL: "https://manywata.vercel.app/", ...extra })[nome];
  const respostaOk = { mediaId: "9001", permalink: "https://www.instagram.com/p/ABC123/", username: "eternizacards", quota: { usado: 4, total: 50 } };
  const fetchServidor = (status = 200, body = respostaOk) =>
    vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));

  test("listarSlides: ordem numérica e só slide-NN.jpg", () => {
    expect(listarSlides(pasta)).toEqual(["slide-01.jpg", "slide-2.jpg", "slide-10.jpg"]);
  });

  test("montarUrls: junta base + nome, com ou sem barra final", () => {
    expect(montarUrls("https://cdn.exemplo.com/c1", ["slide-01.jpg"])).toEqual(["https://cdn.exemplo.com/c1/slide-01.jpg"]);
    expect(montarUrls("https://cdn.exemplo.com/c1/", ["slide 02.jpg"])).toEqual(["https://cdn.exemplo.com/c1/slide%2002.jpg"]);
  });

  test("montarUrls: recusa base http", () => {
    expect(() => montarUrls("http://cdn.exemplo.com/", ["a.jpg"])).toThrow(/https/);
  });

  test("sem --confirmar recusa e não chama nada (nem com --dry-run)", async () => {
    const fetch = fetchServidor();
    await expect(
      executar(["publicar", pasta, "--base-url", "https://cdn.exemplo.com/c1"], { fetch, lerVar: vars(), log: () => {} })
    ).rejects.toThrow(/exige --confirmar/);
    await expect(
      executar(["publicar", pasta, "--base-url", "https://cdn.exemplo.com/c1", "--dry-run"], { fetch, lerVar: vars(), log: () => {} })
    ).rejects.toThrow(/exige --confirmar/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([["rascunho"], ["preview"], [undefined]])("subcomando %s não existe mais", async (cmd) => {
    const fetch = fetchServidor();
    await expect(executar([cmd, pasta, "--confirmar"].filter(Boolean), { fetch, lerVar: vars() })).rejects.toThrow(/Uso:/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("sem --base-url e sem SUPABASE_* no ambiente: recusa sem chamar nada", async () => {
    const fetch = fetchServidor();
    await expect(executar(["publicar", pasta, "--confirmar"], { fetch, lerVar: vars(), env: {} })).rejects.toThrow(
      /SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY[\s\S]*--base-url/
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test("--dry-run mostra o corpo e não chama nada", async () => {
    const fetch = fetchServidor();
    const linhas = [];
    const r = await executar(["publicar", pasta, "--base-url", "https://cdn.exemplo.com/c1", "--confirmar", "--dry-run"], {
      fetch,
      lerVar: vars({ PUBLICAR_SECRET: undefined }),
      log: (l) => linhas.push(l),
    });
    expect(r).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(linhas.join("\n")).toContain("POST https://manywata.vercel.app/api/midia/publicar");
  });

  test("publica: POST /api/midia/publicar com Bearer, slides em ordem, legenda e confirmar: true", async () => {
    const fetch = fetchServidor();
    const linhas = [];
    const r = await executar(
      ["publicar", pasta, "--base-url", "https://cdn.exemplo.com/c1", "--confirmar", "--conta", "eterniza"],
      { fetch, lerVar: vars(), log: (l) => linhas.push(l) }
    );
    expect(r.mediaId).toBe("9001");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://manywata.vercel.app/api/midia/publicar");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${SEGREDO}`);
    expect(JSON.parse(init.body)).toEqual({
      conta: "eterniza",
      tipo: "CAROUSEL",
      itens: ["slide-01.jpg", "slide-2.jpg", "slide-10.jpg"].map((n) => ({ url: `https://cdn.exemplo.com/c1/${n}` })),
      legenda: `${LEGENDA}\n`,
      confirmar: true,
    });
    const saida = linhas.join("\n");
    expect(saida).toContain("https://www.instagram.com/p/ABC123/");
    expect(saida).not.toContain(SEGREDO);
  });

  test("erro do servidor vira mensagem com status e erro", async () => {
    const fetch = fetchServidor(429, { erro: "limite de publicação do Instagram atingido (50/50 nas últimas 24h)." });
    await expect(
      executar(["publicar", pasta, "--base-url", "https://cdn.exemplo.com/c1", "--confirmar"], { fetch, lerVar: vars(), log: () => {} })
    ).rejects.toThrow(/HTTP 429: limite/);
  });

  test("o fetch pra rota leva um AbortSignal (timeout do CLI)", async () => {
    const fetch = fetchServidor();
    await executar(["publicar", pasta, "--base-url", "https://cdn.exemplo.com/c1", "--confirmar"], { fetch, lerVar: vars(), log: () => {} });
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  test("falha de rede avisa pra conferir o perfil antes de repetir", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(
      executar(["publicar", pasta, "--base-url", "https://cdn.exemplo.com/c1", "--confirmar"], { fetch, lerVar: vars(), log: () => {} })
    ).rejects.toThrow(/confira o perfil/);
  });

  test("sem PUBLICAR_SECRET não chama nada", async () => {
    const fetch = fetchServidor();
    await expect(
      executar(["publicar", pasta, "--base-url", "https://cdn.exemplo.com/c1", "--confirmar"], {
        fetch,
        lerVar: vars({ PUBLICAR_SECRET: undefined }),
        log: () => {},
      })
    ).rejects.toThrow(/PUBLICAR_SECRET/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── CLI + Supabase Storage (fetch falso, nunca rede) ──────────────────────

describe("scripts/midia.mjs com Supabase Storage", () => {
  const CHAVE = "eyJhbGciOiJIUzI1NiJ9.chave-service-role-de-teste-0123456789";
  const SUPA = "https://abcdefgh.supabase.co";
  const ENV_SB = { SUPABASE_URL: `${SUPA}/`, SUPABASE_SERVICE_ROLE_KEY: CHAVE };
  const AGORA = () => new Date("2026-11-15T01:05:00Z");
  const PREFIXO = "drop-natal-cartas-20261115-0105-a1b2c3";
  const NOMES = ["slide-01.jpg", "slide-2.jpg", "slide-10.jpg"];
  const CAMINHOS = NOMES.map((n) => `${PREFIXO}/${n}`);
  const PUBLICAS = CAMINHOS.map((c) => `${SUPA}/storage/v1/object/public/instagram-temp/${c}`);
  const respostaOk = { mediaId: "9001", permalink: "https://www.instagram.com/p/ABC123/", username: "eternizacards", quota: { usado: 4, total: 50 } };
  const jpeg = (n = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n)]);

  let raiz, pasta;
  beforeEach(() => {
    raiz = mkdtempSync(join(tmpdir(), "carrossel-"));
    pasta = join(raiz, "Drop Natal: Cartas!", "render");
    mkdirSync(pasta, { recursive: true });
    NOMES.forEach((n, i) => writeFileSync(join(pasta, n), jpeg(10 + i)));
    writeFileSync(join(pasta, "capa.png"), "nao entra");
    writeFileSync(join(pasta, "instagram-post.txt"), `${LEGENDA}\n`);
  });
  afterEach(() => {
    rmSync(raiz, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Responde Storage (upload/delete) e a rota. `falha(chamada, todas)` decide
  // por chamada: Error = falha de rede, {status, body} = resposta de erro.
  function servidor({ falha = () => null } = {}) {
    const chamadas = [];
    const fetch = vi.fn(async (url, init = {}) => {
      const c = { url, metodo: init.method, headers: init.headers, body: init.body };
      chamadas.push(c);
      const f = falha(c, chamadas);
      if (f instanceof Error) throw f;
      // body null = corpo que não é JSON (ex.: página HTML de erro da Vercel)
      if (f) {
        return {
          ok: f.status < 400,
          status: f.status,
          json: async () => {
            if (f.body === null) throw new SyntaxError("Unexpected token '<'");
            return f.body ?? {};
          },
        };
      }
      if (url.endsWith("/api/midia/publicar")) return { ok: true, status: 200, json: async () => respostaOk };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const tipo = (c) =>
      c.url.endsWith("/api/midia/publicar") ? "rota" : c.metodo === "DELETE" ? "delete" : c.metodo === "POST" ? "upload" : "?";
    return { fetch, chamadas, tipos: () => chamadas.map(tipo) };
  }
  const ehRota = (c) => c.url.endsWith("/api/midia/publicar");

  const vars = (extra = {}) => (nome) => ({ PUBLICAR_SECRET: SEGREDO, MANYWATA_URL: "https://manywata.vercel.app", ...extra })[nome];
  const rodar = (fetch, { argv = [], env = ENV_SB, lerVar = vars(), ...resto } = {}) =>
    executar(["publicar", pasta, "--confirmar", ...argv], {
      fetch,
      env,
      lerVar,
      agora: AGORA,
      sufixo: "a1b2c3",
      log: () => {},
      avisar: () => {},
      ...resto,
    });
  const prefixesApagados = (chamadas) => JSON.parse(chamadas.find((c) => c.metodo === "DELETE").body).prefixes;

  test("sobe na ordem com headers certos, passa as URLs públicas pra rota e apaga depois", async () => {
    const { fetch, chamadas, tipos } = servidor();
    const linhas = [];
    const r = await rodar(fetch, { log: (l) => linhas.push(l) });

    expect(r.mediaId).toBe("9001");
    expect(tipos()).toEqual(["upload", "upload", "upload", "rota", "delete"]);
    chamadas.slice(0, 3).forEach((c, i) => {
      expect(c.url).toBe(`${SUPA}/storage/v1/object/instagram-temp/${CAMINHOS[i]}`);
      expect(c.metodo).toBe("POST");
      expect(c.headers).toEqual({
        Authorization: `Bearer ${CHAVE}`,
        apikey: CHAVE,
        "Content-Type": "image/jpeg",
        "x-upsert": "false",
      });
      expect(Buffer.from(c.body).equals(jpeg(10 + i))).toBe(true);
    });

    const rota = chamadas[3];
    expect(rota.headers.Authorization).toBe(`Bearer ${SEGREDO}`);
    expect(JSON.parse(rota.body)).toEqual({
      conta: "eterniza",
      tipo: "CAROUSEL",
      itens: PUBLICAS.map((url) => ({ url })),
      legenda: `${LEGENDA}\n`,
      confirmar: true,
    });
    // a rota aceita essas URLs (https pública)
    for (const url of PUBLICAS) expect(validarUrlPublica(url)).toBe(url);

    const del = chamadas[4];
    expect(del.url).toBe(`${SUPA}/storage/v1/object/instagram-temp`);
    expect(del.headers).toMatchObject({ Authorization: `Bearer ${CHAVE}`, apikey: CHAVE, "Content-Type": "application/json" });
    expect(prefixesApagados(chamadas)).toEqual(CAMINHOS);

    const saida = linhas.join("\n");
    expect(saida).toContain("https://www.instagram.com/p/ABC123/");
    expect(saida).toMatch(/Temporários apagados/);
  });

  test.each([
    ["sem nenhuma", {}, /SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY/],
    ["sem SUPABASE_URL", { SUPABASE_SERVICE_ROLE_KEY: CHAVE }, /Falta SUPABASE_URL no ambiente/],
    ["sem a chave", { SUPABASE_URL: SUPA }, /Falta SUPABASE_SERVICE_ROLE_KEY/],
    ["chave em branco", { SUPABASE_URL: SUPA, SUPABASE_SERVICE_ROLE_KEY: "   " }, /Falta SUPABASE_SERVICE_ROLE_KEY/],
    ["URL http", { SUPABASE_URL: "http://abcdefgh.supabase.co", SUPABASE_SERVICE_ROLE_KEY: CHAVE }, /SUPABASE_URL inválida/],
    ["URL lixo", { SUPABASE_URL: "nao-e-url", SUPABASE_SERVICE_ROLE_KEY: CHAVE }, /SUPABASE_URL inválida/],
  ])("credencial %s → erro claro e zero fetch", async (_n, env, msg) => {
    const { fetch } = servidor();
    const erro = await rodar(fetch, { env }).catch((e) => e);
    expect(erro.message).toMatch(msg);
    expect(erro.message).not.toContain(CHAVE);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("lê só do env: SUPABASE_* vindo do lerVar (.env.local) não conta", async () => {
    const { fetch } = servidor();
    await expect(rodar(fetch, { env: {}, lerVar: vars(ENV_SB) })).rejects.toThrow(/SUPABASE_URL/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("sem PUBLICAR_SECRET → recusa antes de subir", async () => {
    const { fetch } = servidor();
    await expect(rodar(fetch, { lerVar: vars({ PUBLICAR_SECRET: undefined }) })).rejects.toThrow(/PUBLICAR_SECRET/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("arquivo que não é JPEG → erro e nenhum upload", async () => {
    writeFileSync(join(pasta, "slide-2.jpg"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const { fetch } = servidor();
    await expect(rodar(fetch)).rejects.toThrow(/slide-2\.jpg não é JPEG/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("arquivo vazio → erro e nenhum upload", async () => {
    writeFileSync(join(pasta, "slide-01.jpg"), "");
    const { fetch } = servidor();
    await expect(rodar(fetch)).rejects.toThrow(/slide-01\.jpg não é JPEG/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("arquivo > 8 MB → erro e nenhum upload; exatamente 8 MB passa", async () => {
    writeFileSync(join(pasta, "slide-10.jpg"), jpeg(MAX_BYTES - 3));
    const { fetch } = servidor();
    await expect(rodar(fetch)).rejects.toThrow(/slide-10\.jpg tem 8\.0 MB; o limite do bucket é 8 MB/);
    expect(fetch).not.toHaveBeenCalled();

    writeFileSync(join(pasta, "slide-10.jpg"), jpeg(MAX_BYTES - 4));
    await expect(rodar(servidor().fetch)).resolves.toMatchObject({ mediaId: "9001" });
  });

  test("sem legenda → erro e nenhum upload", async () => {
    rmSync(join(pasta, "instagram-post.txt"));
    const { fetch } = servidor();
    await expect(rodar(fetch)).rejects.toThrow(/Não achei a legenda/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("1 slide só → erro e nenhum upload", async () => {
    rmSync(join(pasta, "slide-2.jpg"));
    rmSync(join(pasta, "slide-10.jpg"));
    const { fetch } = servidor();
    await expect(rodar(fetch)).rejects.toThrow(/2 a 10 slides/);
    expect(fetch).not.toHaveBeenCalled();
  });

  // Resultado DEFINIDO (a rota diz publicado: false e não é 504) → apaga.
  // Antes o 429 vinha só com {erro}; agora a rota manda publicado: false e o
  // CLI exige esse campo pra apagar.
  test.each([
    [429, "limite de publicação atingido (50/50)"],
    [400, "itens[0].url: só https é aceito"],
    [502, "slide 3 de 3: container 1002 falhou no Instagram (ERROR)"],
  ])("rota devolve %i com publicado: false → apaga tudo o que subiu", async (status, erro) => {
    const { fetch, chamadas, tipos } = servidor({
      falha: (c) => (ehRota(c) ? { status, body: { erro, publicado: false } } : null),
    });
    const e = await rodar(fetch).catch((x) => x);
    expect(e.message).toMatch(new RegExp(`^HTTP ${status}: `));
    expect(e.message).toMatch(/Nada foi publicado/);
    expect(e.message).not.toMatch(/limpar/);
    expect(tipos()).toEqual(["upload", "upload", "upload", "rota", "delete"]);
    expect(prefixesApagados(chamadas)).toEqual(CAMINHOS);
  });

  // Resultado INDEFINIDO → NÃO apaga, imprime os caminhos e o que fazer.
  // Antes estes casos apagavam ("o Meta já baixou"); mas o Meta pode ainda
  // estar processando os containers quando o CLI recebe o erro.
  const fetchQueRespeitaAbort = () =>
    vi.fn((url, init) =>
      url.endsWith("/api/midia/publicar")
        ? new Promise((_, rejeitar) => init.signal.addEventListener("abort", () => rejeitar(init.signal.reason)))
        : Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    );

  test.each([
    ["504 sem corpo (timeout da Vercel)", { status: 504 }, /HTTP 504: sem detalhe[\s\S]*Resposta sem detalhe[\s\S]*confira o perfil ANTES de rodar de novo/],
    ["504 da rota com publicado: false", { status: 504, body: { erro: "slide 1 de 3: container 1000 não ficou pronto em 240s (último status: IN_PROGRESS). Nada foi publicado.", publicado: false } }, /HTTP 504: slide 1[\s\S]*não chegou a publicar/],
    ["502 sem publicado (media_publish chamado)", { status: 502, body: { erro: "Instagram recusou POST x/media_publish: Fatal" } }, /HTTP 502: Instagram recusou[\s\S]*pode ter publicado/],
    ["500 com HTML", { status: 500, body: null }, /HTTP 500: sem detalhe/],
    ["200 sem mediaId", { status: 200, body: {} }, /HTTP 200 sem mediaId[\s\S]*pode ter publicado/],
    ["falha de rede", new TypeError("fetch failed"), /Falha de rede chamando[\s\S]*Pode ter publicado mesmo assim: confira o perfil/],
  ])("%s → NÃO apaga e imprime caminhos + instrução", async (_n, resposta, msg) => {
    const { fetch, tipos } = servidor({ falha: (c) => (ehRota(c) ? resposta : null) });
    const e = await rodar(fetch).catch((x) => x);
    expect(e.message).toMatch(msg);
    expect(e.message).toMatch(/temporários NÃO foram apagados/);
    for (const c of CAMINHOS) expect(e.message).toContain(`instagram-temp/${c}`);
    expect(e.message).toContain(`node scripts/midia.mjs limpar ${PREFIXO} --confirmar`);
    expect(e.message).toMatch(/Confira o perfil/);
    expect(tipos()).not.toContain("delete");
  });

  test("timeout do CLI (abort) → NÃO apaga e explica", async () => {
    const fetch = fetchQueRespeitaAbort();
    const e = await rodar(fetch, { timeoutRotaMs: 20 }).catch((x) => x);
    expect(e.message).toMatch(/Sem resposta de https:\/\/manywata\.vercel\.app\/api\/midia\/publicar em 0s \(timeout do CLI\)/);
    expect(e.message).toContain(`limpar ${PREFIXO} --confirmar`);
    expect(fetch.mock.calls.some(([, init]) => init.method === "DELETE")).toBe(false);
  });

  test("timeout padrão do CLI é maior que o maxDuration da função", () => {
    expect(CLI_TIMEOUT_ROTA_MS).toBe(330_000);
    expect(CLI_TIMEOUT_ROTA_MS).toBeGreaterThan(MAX_DURATION_S * 1000);
  });

  test("upload parcial (2º recusado) → não chama a rota e apaga o que foi tentado", async () => {
    const { fetch, chamadas, tipos } = servidor({
      falha: (c, todas) => (c.metodo === "POST" && todas.length === 2 ? { status: 500, body: { message: "Internal" } } : null),
    });
    await expect(rodar(fetch)).rejects.toThrow(/Storage recusou slide-2\.jpg \(HTTP 500\): Internal[\s\S]*Nada foi publicado/);
    expect(tipos()).toEqual(["upload", "upload", "delete"]);
    expect(prefixesApagados(chamadas)).toEqual(CAMINHOS.slice(0, 2));
  });

  test("falha de rede no 1º upload → não chama a rota e apaga mesmo assim", async () => {
    const { fetch, chamadas, tipos } = servidor({ falha: (_c, todas) => (todas.length === 1 ? new TypeError("fetch failed") : null) });
    await expect(rodar(fetch)).rejects.toThrow(/Falha de rede subindo slide-01\.jpg/);
    expect(tipos()).toEqual(["upload", "delete"]);
    expect(prefixesApagados(chamadas)).toEqual(CAMINHOS.slice(0, 1));
  });

  test("apagar falhou depois de publicar → sucesso mesmo assim, com aviso listando os caminhos", async () => {
    const { fetch } = servidor({ falha: (c) => (c.metodo === "DELETE" ? { status: 503, body: { message: "indisponível" } } : null) });
    const avisos = [];
    const r = await rodar(fetch, { avisar: (l) => avisos.push(l) });
    expect(r.mediaId).toBe("9001");
    const aviso = avisos.join("\n");
    expect(aviso).toMatch(/não consegui apagar/);
    for (const c of CAMINHOS) expect(aviso).toContain(`instagram-temp/${c}`);
  });

  test("apagar falhou depois de erro da rota → o erro da rota continua sendo o erro", async () => {
    const { fetch } = servidor({
      falha: (c) =>
        c.metodo === "DELETE"
          ? new TypeError("fetch failed")
          : ehRota(c)
            ? { status: 400, body: { erro: "itens[0].url inválida", publicado: false } } // antes sem publicado
            : null,
    });
    const avisos = [];
    await expect(rodar(fetch, { avisar: (l) => avisos.push(l) })).rejects.toThrow(/HTTP 400: itens\[0\]/);
    expect(avisos.join("\n")).toMatch(/não consegui apagar/);
  });

  test("--base-url pula o Storage mesmo com SUPABASE_* no ambiente", async () => {
    const { fetch, chamadas, tipos } = servidor();
    await rodar(fetch, { argv: ["--base-url", "https://cdn.exemplo.com/c1"] });
    expect(tipos()).toEqual(["rota"]);
    expect(JSON.parse(chamadas[0].body).itens[0].url).toBe("https://cdn.exemplo.com/c1/slide-01.jpg");
  });

  test("--dry-run: zero fetch, mostra caminhos e URLs públicas", async () => {
    const { fetch } = servidor();
    const linhas = [];
    const r = await rodar(fetch, { argv: ["--dry-run"], log: (l) => linhas.push(l) });
    expect(r).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    const saida = linhas.join("\n");
    for (const c of CAMINHOS) expect(saida).toContain(`instagram-temp/${c}`);
    for (const u of PUBLICAS) expect(saida).toContain(u);
    expect(saida).not.toContain(CHAVE);
  });

  test("--dry-run sem credenciais nem PUBLICAR_SECRET: zero fetch, só avisa", async () => {
    const { fetch } = servidor();
    const linhas = [];
    await rodar(fetch, { argv: ["--dry-run"], env: {}, lerVar: vars({ PUBLICAR_SECRET: undefined }), log: (l) => linhas.push(l) });
    expect(fetch).not.toHaveBeenCalled();
    expect(linhas.join("\n")).toMatch(/SUPABASE_URL\/SUPABASE_SERVICE_ROLE_KEY ausentes[\s\S]*<SUPABASE_URL>\/storage/);
  });

  test("a chave nunca aparece em stdout/stderr/erros, mesmo com o servidor ecoando", async () => {
    const espioes = ["log", "warn", "error", "info", "debug"].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const eco = `apikey ${CHAVE} Authorization: Bearer ${CHAVE}`;
    // log/avisar padrão (console), pra pegar tudo no espião
    const real = (fetch, argv = [], env = ENV_SB) =>
      executar(["publicar", pasta, "--confirmar", ...argv], { fetch, env, lerVar: vars(), agora: AGORA, sufixo: "a1b2c3" });
    const erros = [];
    const pega = (p) => p.catch((e) => erros.push(e.message));
    const upload = (c) => c.metodo === "POST" && !ehRota(c);

    await pega(real(servidor().fetch)); // feliz
    await pega(real(servidor({ falha: (c) => (upload(c) ? { status: 403, body: { message: eco } } : null) }).fetch));
    await pega(real(servidor({ falha: (_c, t) => (t.length === 2 ? new TypeError(`fetch failed ${eco}`) : null) }).fetch));
    await pega(real(servidor({ falha: (c) => (ehRota(c) ? { status: 502, body: { erro: eco } } : null) }).fetch));
    await pega(real(servidor({ falha: (c) => (ehRota(c) ? new TypeError(eco) : null) }).fetch));
    await pega(real(servidor({ falha: (c) => (c.metodo === "DELETE" ? { status: 500, body: { error: eco } } : null) }).fetch));
    await pega(real(servidor({ falha: (c) => (c.metodo === "DELETE" ? new TypeError(eco) : null) }).fetch));
    await pega(real(servidor().fetch, [], { SUPABASE_URL: `x${CHAVE}`, SUPABASE_SERVICE_ROLE_KEY: CHAVE }));
    await pega(real(servidor().fetch, ["--dry-run"]));

    expect(erros).toHaveLength(5);
    const logado = espioes.flatMap((s) => s.mock.calls.flat()).map(String).join("\n");
    expect(logado).toMatch(/não consegui apagar/);
    expect(logado).toMatch(/Publicado em @eternizacards/);
    const tudo = `${erros.join("\n")}\n${logado}`;
    expect(tudo).toContain("[oculto]");
    expect(tudo).not.toContain(CHAVE);
    expect(tudo).not.toContain(SEGREDO);
  });
});

// ── CLI story <arquivo.jpg> (fetch falso, nunca rede) ─────────────────────

// JPEG mínimo com APP0 + SOF0 declarando largura x altura (não precisa
// decodificar; o CLI só lê o cabeçalho).
function jpegComDimensoes(largura, altura, extra = 32) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, altura >> 8, altura & 0xff, largura >> 8, largura & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.concat([Buffer.from([0xff, 0xd8, ...app0, ...sof0]), Buffer.alloc(extra), Buffer.from([0xff, 0xd9])]);
}

describe("scripts/midia.mjs story <arquivo.jpg>", () => {
  const CHAVE = "eyJhbGciOiJIUzI1NiJ9.chave-service-role-de-teste-0123456789";
  const SUPA = "https://abcdefgh.supabase.co";
  const ENV_SB = { SUPABASE_URL: SUPA, SUPABASE_SERVICE_ROLE_KEY: CHAVE };
  const AGORA = () => new Date("2026-11-15T01:05:00Z");
  const PREFIXO = "promo-natal-20261115-0105-a1b2c3";
  const CAMINHO = `${PREFIXO}/promo-natal.jpg`;
  const PUBLICA = `${SUPA}/storage/v1/object/public/instagram-temp/${CAMINHO}`;
  const respostaOk = { mediaId: "9001", permalink: "https://www.instagram.com/stories/eternizacards/9001/", username: "eternizacards", quota: { usado: 4, total: 50 } };

  let raiz, arquivo;
  beforeEach(() => {
    raiz = mkdtempSync(join(tmpdir(), "story-"));
    arquivo = join(raiz, "Promo Natal!.jpg");
    writeFileSync(arquivo, jpegComDimensoes(1080, 1920));
  });
  afterEach(() => rmSync(raiz, { recursive: true, force: true }));

  function servidor({ falha = () => null, resposta = respostaOk } = {}) {
    const chamadas = [];
    const fetch = vi.fn(async (url, init = {}) => {
      const c = { url, metodo: init.method, headers: init.headers, body: init.body };
      chamadas.push(c);
      const f = falha(c);
      if (f instanceof Error) throw f;
      if (f) return { ok: f.status < 400, status: f.status, json: async () => f.body ?? {} };
      if (url.endsWith("/api/midia/publicar")) return { ok: true, status: 200, json: async () => resposta };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const tipo = (c) =>
      c.url.endsWith("/api/midia/publicar") ? "rota" : c.metodo === "DELETE" ? "delete" : c.metodo === "POST" ? "upload" : "?";
    return { fetch, chamadas, tipos: () => chamadas.map(tipo) };
  }
  const ehRota = (c) => c.url.endsWith("/api/midia/publicar");
  const vars = (extra = {}) => (nome) => ({ PUBLICAR_SECRET: SEGREDO, MANYWATA_URL: "https://manywata.vercel.app", ...extra })[nome];
  const rodar = (fetch, { argv = ["--confirmar"], alvo = arquivo, env = ENV_SB, lerVar = vars(), ...resto } = {}) =>
    executar(["story", alvo, ...argv], {
      fetch,
      env,
      lerVar,
      agora: AGORA,
      sufixo: "a1b2c3",
      log: () => {},
      avisar: () => {},
      ...resto,
    });

  test("sobe 1 arquivo, chama a rota com tipo STORIES (sem legenda) e apaga depois", async () => {
    const { fetch, chamadas, tipos } = servidor();
    const linhas = [];
    const avisos = [];
    const r = await rodar(fetch, { log: (l) => linhas.push(l), avisar: (l) => avisos.push(l) });

    expect(r.mediaId).toBe("9001");
    expect(tipos()).toEqual(["upload", "rota", "delete"]);

    const up = chamadas[0];
    expect(up.url).toBe(`${SUPA}/storage/v1/object/instagram-temp/${CAMINHO}`);
    expect(up.headers).toEqual({ Authorization: `Bearer ${CHAVE}`, apikey: CHAVE, "Content-Type": "image/jpeg", "x-upsert": "false" });
    expect(Buffer.from(up.body).equals(jpegComDimensoes(1080, 1920))).toBe(true);

    const rota = chamadas[1];
    expect(rota.url).toBe("https://manywata.vercel.app/api/midia/publicar");
    expect(rota.headers.Authorization).toBe(`Bearer ${SEGREDO}`);
    expect(JSON.parse(rota.body)).toEqual({ conta: "eterniza", tipo: "STORIES", itens: [{ url: PUBLICA }], confirmar: true });
    expect(validarUrlPublica(PUBLICA)).toBe(PUBLICA);

    expect(JSON.parse(chamadas[2].body).prefixes).toEqual([CAMINHO]);
    const saida = linhas.join("\n");
    expect(saida).toMatch(/Publicando story \(1 imagem\)/);
    expect(saida).toContain(respostaOk.permalink);
    expect(saida).toMatch(/Temporários apagados/);
    expect(avisos).toEqual([]); // 1080x1920: nada a avisar
    expect(`${saida}\n${avisos.join("\n")}`).not.toContain(CHAVE);
  });

  test("--conta é repassada", async () => {
    const { fetch, chamadas } = servidor();
    await rodar(fetch, { argv: ["--confirmar", "--conta", "outra"] });
    expect(JSON.parse(chamadas.find(ehRota).body).conta).toBe("outra");
  });

  test("story sem permalink → sucesso, mensagem tranquila", async () => {
    const { fetch } = servidor({ resposta: { ...respostaOk, permalink: null } });
    const linhas = [];
    const r = await rodar(fetch, { log: (l) => linhas.push(l) });
    expect(r.mediaId).toBe("9001");
    expect(linhas.join("\n")).toMatch(/story sem permalink; normal/);
  });

  test.each([
    ["1080x1080", 1080, 1080],
    ["1920x1080 (deitada)", 1920, 1080],
  ])("dimensões %s → avisa mas publica", async (_n, w, h) => {
    writeFileSync(arquivo, jpegComDimensoes(w, h));
    const { fetch, tipos } = servidor();
    const avisos = [];
    const r = await rodar(fetch, { avisar: (l) => avisos.push(l) });
    expect(r.mediaId).toBe("9001");
    expect(avisos.join("\n")).toMatch(new RegExp(`${w}x${h}.*recomendado pra story é 1080x1920`));
    expect(tipos()).toEqual(["upload", "rota", "delete"]);
  });

  test("dimensões ilegíveis → avisa mas publica", async () => {
    writeFileSync(arquivo, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]));
    const { fetch } = servidor();
    const avisos = [];
    await expect(rodar(fetch, { avisar: (l) => avisos.push(l) })).resolves.toMatchObject({ mediaId: "9001" });
    expect(avisos.join("\n")).toMatch(/não consegui ler as dimensões/);
  });

  test("sem --confirmar recusa e zero fetch (nem com --dry-run)", async () => {
    const { fetch } = servidor();
    await expect(rodar(fetch, { argv: [] })).rejects.toThrow(/story exige --confirmar/);
    await expect(rodar(fetch, { argv: ["--dry-run"] })).rejects.toThrow(/story exige --confirmar/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("--dry-run: zero fetch, mostra caminho, URL pública e corpo STORIES sem legenda", async () => {
    const { fetch } = servidor();
    const linhas = [];
    const r = await rodar(fetch, { argv: ["--confirmar", "--dry-run"], log: (l) => linhas.push(l) });
    expect(r).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    const saida = linhas.join("\n");
    expect(saida).toContain(`instagram-temp/${CAMINHO}`);
    expect(saida).toContain(PUBLICA);
    expect(saida).toContain('"tipo": "STORIES"');
    expect(saida).not.toContain("legenda");
    expect(saida).not.toContain(CHAVE);
  });

  test("--dry-run sem credenciais nem PUBLICAR_SECRET: zero fetch, só avisa", async () => {
    const { fetch } = servidor();
    const linhas = [];
    await rodar(fetch, { argv: ["--confirmar", "--dry-run"], env: {}, lerVar: vars({ PUBLICAR_SECRET: undefined }), log: (l) => linhas.push(l) });
    expect(fetch).not.toHaveBeenCalled();
    expect(linhas.join("\n")).toMatch(/ausentes[\s\S]*<SUPABASE_URL>\/storage/);
  });

  test("--base-url: só chama a rota, com <base>/<nome do arquivo>", async () => {
    const { fetch, chamadas, tipos } = servidor();
    await rodar(fetch, { argv: ["--confirmar", "--base-url", "https://cdn.exemplo.com/st"] });
    expect(tipos()).toEqual(["rota"]);
    expect(JSON.parse(chamadas[0].body)).toEqual({
      conta: "eterniza",
      tipo: "STORIES",
      itens: [{ url: "https://cdn.exemplo.com/st/Promo%20Natal!.jpg" }],
      confirmar: true,
    });
  });

  test("504 da rota (publicado: false) → NÃO apaga e instrui", async () => {
    const { fetch, tipos } = servidor({
      falha: (c) => (ehRota(c) ? { status: 504, body: { erro: "container 1000 não ficou pronto em 240s (último status: IN_PROGRESS). Nada foi publicado.", publicado: false } } : null),
    });
    const e = await rodar(fetch).catch((x) => x);
    expect(e.message).toMatch(/HTTP 504/);
    expect(e.message).toMatch(/temporários NÃO foram apagados/);
    expect(e.message).toContain(`instagram-temp/${CAMINHO}`);
    expect(e.message).toContain(`node scripts/midia.mjs limpar ${PREFIXO} --confirmar`);
    expect(e.message).toMatch(/rode o mesmo comando de novo/);
    expect(tipos()).not.toContain("delete");
  });

  test("falha de rede na rota → NÃO apaga", async () => {
    const { fetch, tipos } = servidor({ falha: (c) => (ehRota(c) ? new TypeError("fetch failed") : null) });
    await expect(rodar(fetch)).rejects.toThrow(/Pode ter publicado mesmo assim/);
    expect(tipos()).toEqual(["upload", "rota"]);
  });

  test("400 da rota com publicado: false → apaga", async () => {
    const { fetch, chamadas, tipos } = servidor({
      falha: (c) => (ehRota(c) ? { status: 400, body: { erro: "story não tem legenda", publicado: false } } : null),
    });
    await expect(rodar(fetch)).rejects.toThrow(/HTTP 400[\s\S]*Nada foi publicado/);
    expect(tipos()).toEqual(["upload", "rota", "delete"]);
    expect(JSON.parse(chamadas[2].body).prefixes).toEqual([CAMINHO]);
  });

  test("não é JPEG → erro e zero fetch", async () => {
    writeFileSync(arquivo, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const { fetch } = servidor();
    await expect(rodar(fetch)).rejects.toThrow(/Promo Natal!\.jpg não é JPEG/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("> 8 MB → erro e zero fetch", async () => {
    writeFileSync(arquivo, Buffer.concat([jpegComDimensoes(1080, 1920), Buffer.alloc(MAX_BYTES)]));
    const { fetch } = servidor();
    await expect(rodar(fetch)).rejects.toThrow(/limite do bucket é 8 MB/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("arquivo inexistente / sem arquivo → erro claro e zero fetch", async () => {
    const { fetch } = servidor();
    await expect(rodar(fetch, { alvo: join(raiz, "nao-existe.jpg") })).rejects.toThrow(/Não consegui ler o arquivo/);
    await expect(rodar(fetch, { alvo: raiz })).rejects.toThrow(/Não consegui ler o arquivo/);
    await expect(executar(["story", "--confirmar"], { fetch, lerVar: vars() })).rejects.toThrow(/Falta o arquivo JPEG/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("sem SUPABASE_* ou sem PUBLICAR_SECRET → recusa e zero fetch", async () => {
    const { fetch } = servidor();
    await expect(rodar(fetch, { env: {} })).rejects.toThrow(/SUPABASE_URL/);
    await expect(rodar(fetch, { lerVar: vars({ PUBLICAR_SECRET: undefined }) })).rejects.toThrow(/PUBLICAR_SECRET/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("nome de arquivo sem letras vira slug 'story'", async () => {
    const outro = join(raiz, "!!!.jpg");
    writeFileSync(outro, jpegComDimensoes(1080, 1920));
    const { fetch, chamadas } = servidor();
    await rodar(fetch, { alvo: outro });
    expect(chamadas[0].url).toBe(`${SUPA}/storage/v1/object/instagram-temp/story-20261115-0105-a1b2c3/story.jpg`);
  });
});

describe("dimensoesJpeg", () => {
  test("lê largura x altura do SOF0 e do SOF2 (progressivo)", () => {
    expect(dimensoesJpeg(jpegComDimensoes(1080, 1920))).toEqual({ largura: 1080, altura: 1920 });
    const prog = jpegComDimensoes(640, 480);
    prog[prog.indexOf(0xc0, 4)] = 0xc2;
    expect(dimensoesJpeg(prog)).toEqual({ largura: 640, altura: 480 });
  });

  test("não é JPEG, truncado ou sem SOF → null", () => {
    expect(dimensoesJpeg(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(dimensoesJpeg(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(dimensoesJpeg(jpegComDimensoes(1080, 1920).subarray(0, 25))).toBeNull(); // corta no meio do SOF
    expect(dimensoesJpeg(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]))).toBeNull();
  });
});

describe("scripts/midia.mjs limpar <prefixo>", () => {
  const CHAVE = "eyJhbGciOiJIUzI1NiJ9.chave-service-role-de-teste-0123456789";
  const SUPA = "https://abcdefgh.supabase.co";
  const ENV_SB = { SUPABASE_URL: SUPA, SUPABASE_SERVICE_ROLE_KEY: CHAVE };
  const PREFIXO = "drop-natal-cartas-20261115-0105-a1b2c3";

  // Storage falso: listagem devolve `arquivos` (+ uma subpasta, id null).
  function storage({ arquivos = ["slide-01.jpg", "slide-02.jpg"], falha = () => null } = {}) {
    const chamadas = [];
    const fetch = vi.fn(async (url, init = {}) => {
      const c = { url, metodo: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
      chamadas.push(c);
      const f = falha(c);
      if (f instanceof Error) throw f;
      if (f) return { ok: false, status: f.status, json: async () => f.body ?? {} };
      if (url.includes("/object/list/")) {
        return { ok: true, status: 200, json: async () => [...arquivos.map((name) => ({ name, id: `id-${name}` })), { name: "sub", id: null }] };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    return { fetch, chamadas };
  }
  const rodar = (argv, { fetch, env = ENV_SB, log = () => {} } = {}) => executar(["limpar", ...argv], { fetch, env, log, lerVar: () => undefined });

  test("sem --confirmar → recusa e zero fetch", async () => {
    const { fetch } = storage();
    await expect(rodar([PREFIXO], { fetch })).rejects.toThrow(/limpar exige --confirmar/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    ["vazio", []],
    ["com barra no meio", ["drop/natal", "--confirmar"]],
    ["com ..", ["..", "--confirmar"]],
    ["com maiúsculas", ["Drop-Natal", "--confirmar"]],
    ["só o bucket", ["instagram-temp/", "--confirmar"]],
  ])("prefixo %s → recusa e zero fetch", async (_n, argv) => {
    const { fetch } = storage();
    await expect(rodar(argv, { fetch })).rejects.toThrow(/prefixo/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("sem SUPABASE_* no ambiente → recusa e zero fetch", async () => {
    const { fetch } = storage();
    await expect(rodar([PREFIXO, "--confirmar"], { fetch, env: {} })).rejects.toThrow(/SUPABASE_URL/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([PREFIXO, `${PREFIXO}/`, `instagram-temp/${PREFIXO}/`])("com --confirmar (%s): lista a pasta e apaga só os arquivos dela", async (alvo) => {
    const { fetch, chamadas } = storage();
    const linhas = [];
    const r = await rodar([alvo, "--confirmar"], { fetch, log: (l) => linhas.push(l) });
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([
      `POST ${SUPA}/storage/v1/object/list/instagram-temp`,
      `DELETE ${SUPA}/storage/v1/object/instagram-temp`,
    ]);
    expect(chamadas[0].body).toMatchObject({ prefix: PREFIXO, offset: 0 });
    expect(chamadas[0].headers).toMatchObject({ Authorization: `Bearer ${CHAVE}`, apikey: CHAVE });
    expect(chamadas[1].body).toEqual({ prefixes: [`${PREFIXO}/slide-01.jpg`, `${PREFIXO}/slide-02.jpg`] });
    expect(r.apagados).toHaveLength(2);
    expect(linhas.join("\n")).toMatch(/Apagados 2 arquivo/);
    expect(linhas.join("\n")).not.toContain(CHAVE);
  });

  test("pasta vazia → não chama DELETE", async () => {
    const { fetch, chamadas } = storage({ arquivos: [] });
    const linhas = [];
    await rodar([PREFIXO, "--confirmar"], { fetch, log: (l) => linhas.push(l) });
    expect(chamadas.map((c) => c.metodo)).toEqual(["POST"]);
    expect(linhas.join("\n")).toMatch(/Nada pra apagar/);
  });

  test("erro do Storage vira mensagem sanitizada", async () => {
    const { fetch } = storage({ falha: (c) => (c.metodo === "DELETE" ? { status: 500, body: { message: `ruim ${CHAVE}` } } : null) });
    const e = await rodar([PREFIXO, "--confirmar"], { fetch }).catch((x) => x);
    expect(e.message).toMatch(/Storage recusou apagar \(HTTP 500\): ruim \[oculto\]/);
    expect(e.message).not.toContain(CHAVE);
  });
});

describe("scripts/_storage.mjs (partes)", () => {
  const cred = { url: "https://abcdefgh.supabase.co", chave: "chave-service-role-de-teste-0123456789" };

  test("sanitizarSlug / slugDaPasta", () => {
    expect(sanitizarSlug("Drop Natal: Cartas!")).toBe("drop-natal-cartas");
    expect(sanitizarSlug("Edição Ç ÁÉÍ")).toBe("edicao-c-aei");
    expect(sanitizarSlug("***")).toBe("carrossel");
    expect(sanitizarSlug("a".repeat(70))).toHaveLength(60);
    expect(slugDaPasta("/tmp/x/Lançamento 2026/render")).toBe("lancamento-2026");
    expect(slugDaPasta("/tmp/x/Lançamento 2026/RENDER/")).toBe("lancamento-2026");
    expect(slugDaPasta("/tmp/x/meu_post")).toBe("meu-post");
  });

  test("carimbo: AAAAMMDD-HHMM (UTC) + sufixo aleatório", () => {
    expect(carimbo(new Date("2026-11-15T01:05:59Z"), "abc123")).toBe("20261115-0105-abc123");
    expect(carimbo(new Date("2026-01-02T23:09:00Z"))).toMatch(/^20260102-2309-[0-9a-f]{6}$/);
  });

  test("lerCredenciaisStorage normaliza a URL (sem barra final)", () => {
    expect(lerCredenciaisStorage({ SUPABASE_URL: " https://abcdefgh.supabase.co/ ", SUPABASE_SERVICE_ROLE_KEY: " k " })).toEqual({
      url: "https://abcdefgh.supabase.co",
      chave: "k",
    });
  });

  test("enviarParaStorage: tudo ok devolve caminhos e URLs públicas", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const r = await enviarParaStorage({ arquivos: [{ nome: "slide-01.jpg", bytes: Buffer.from([0xff, 0xd8, 0xff]) }], prefixo: "p-1", cred, fetch });
    expect(r).toEqual({
      caminhos: ["p-1/slide-01.jpg"],
      urls: ["https://abcdefgh.supabase.co/storage/v1/object/public/instagram-temp/p-1/slide-01.jpg"],
    });
  });

  test("apagarDoStorage: lista vazia não chama nada; erro HTTP vira exceção sanitizada", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ message: `ruim ${cred.chave}` }) }));
    await apagarDoStorage({ caminhos: [], cred, fetch });
    expect(fetch).not.toHaveBeenCalled();
    const e = await apagarDoStorage({ caminhos: ["p/a.jpg"], cred, fetch }).catch((x) => x);
    expect(e.message).toBe("Storage recusou apagar (HTTP 400): ruim [oculto]");
    expect(fetch.mock.calls[0][1].method).toBe("DELETE");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ prefixes: ["p/a.jpg"] });
  });
});
