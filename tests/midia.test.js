// Publicação de mídia (POST /api/midia/publicar, uma chamada só). Tudo com
// fetch falso: nenhum teste chama o Instagram de verdade.

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotaPublicar } from "../api/_lib/rotas-midia.js";
import { sanitizar, validarUrlPublica, ErroHttp } from "../api/_lib/seguranca.js";
import { TIPOS, validarLegenda } from "../api/_lib/instagram-publicacao.js";
import rotaMidiaPublicar from "../api/midia/publicar.js";
import aliasCarrossel from "../api/carrossel/publicar.js";
import { listarSlides, montarUrls, executar } from "../scripts/midia.mjs";

const SEGREDO = "segredo-de-teste-com-bem-mais-de-32-caracteres";
const TOKEN = "IGAAtokenSuperSecretoDaEterniza0123456789";
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

// Relógio falso: sleep só avança o tempo, ninguém espera de verdade.
function relogio(inicio = T0) {
  const r = { t: inicio };
  r.now = () => r.t;
  r.sleep = vi.fn(async (ms) => { r.t += ms; });
  return r;
}

// Imita o Graph: cria containers com ids sequenciais, status configurável.
function meta({ status = () => "FINISHED", quota = 0, total = 50, falhar = {} } = {}) {
  let proximo = 1000;
  const chamadas = [];
  const fetch = vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    const metodo = init.method || "GET";
    const caminho = u.pathname.replace(/^\/v21\.0\//, "");
    const params = metodo === "GET" ? Object.fromEntries(u.searchParams) : JSON.parse(init.body);
    chamadas.push({ metodo, caminho, params, url, headers: init.headers });
    const ok = (body, st = 200) => ({ ok: st < 400, status: st, json: async () => body });
    const chave = `${metodo} ${caminho}${params.fields ? `?${params.fields}` : ""}`;
    if (falhar[chave]) return ok({ error: { message: falhar[chave] } }, 400);

    if (metodo === "POST" && caminho === `${USER}/media`) return ok({ id: String(proximo++) });
    if (metodo === "POST" && caminho === `${USER}/media_publish`) return ok({ id: "9001" });
    if (caminho === `${USER}/content_publishing_limit`) {
      return ok({ data: [{ quota_usage: quota, config: { quota_total: total } }] });
    }
    if (params.fields === "status_code,status") {
      const s = status(caminho);
      return ok({ id: caminho, status_code: s, status: s === "ERROR" ? "Error: Media download has failed" : s });
    }
    if (params.fields === "permalink") return ok({ id: caminho, permalink: "https://www.instagram.com/p/ABC123/" });
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

  test.each(["REELS", "STORIES", "reels"])("tipo %s → 501 e zero fetch", async (tipo) => {
    const { fetch } = meta();
    const res = await publicar({ body: corpo({ tipo }), fetch });
    expect(res.statusCode).toBe(501);
    expect(res.body.erro).toMatch(/não implementado/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("registro de tipos: só CAROUSEL implementado", () => {
    expect(Object.keys(TIPOS)).toEqual(["CAROUSEL", "REELS", "STORIES"]);
    expect(TIPOS.CAROUSEL.implementado).toBe(true);
    expect(TIPOS.REELS.implementado).toBe(false);
    expect(TIPOS.STORIES.implementado).toBe(false);
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

  test("orçamento padrão cabe nos 60s da função", async () => {
    const { fetch } = meta({ status: () => "IN_PROGRESS" });
    const rel = relogio();
    const res = await publicar({ fetch, ...rel });
    expect(res.statusCode).toBe(504);
    expect(rel.t - T0).toBeLessThanOrEqual(50_000);
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

  test("/api/carrossel/publicar com tipo REELS → 400 e zero fetch", async () => {
    const { fetch } = meta();
    vi.stubGlobal("fetch", fetch);
    const res = fakeRes();
    await aliasCarrossel(fakeReq({ body: corpo({ tipo: "REELS" }) }), res);
    expect(res.statusCode).toBe(400);
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

  test("sem --base-url recusa e lista os slides", async () => {
    const fetch = fetchServidor();
    await expect(executar(["publicar", pasta, "--confirmar"], { fetch, lerVar: vars() })).rejects.toThrow(/--base-url[\s\S]*slide-01\.jpg/);
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
