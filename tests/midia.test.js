// Publicação de mídia (rascunho → publicar). Tudo com fetch falso: nenhum
// teste chama o Instagram de verdade.

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotaRascunho, rotaPublicar, rotaPreview } from "../api/_lib/rotas-midia.js";
import {
  assinarRascunho,
  lerRascunho,
  sanitizar,
  validarUrlPublica,
  ErroHttp,
} from "../api/_lib/seguranca.js";
import { TIPOS, validarLegenda } from "../api/_lib/instagram-publicacao.js";
import aliasRascunho from "../api/carrossel/rascunho.js";
import aliasPublicar from "../api/carrossel/publicar.js";
import { listarSlides, montarUrls } from "../scripts/midia.mjs";

const SEGREDO = "segredo-de-teste-com-bem-mais-de-32-caracteres";
const TOKEN = "IGAAtokenSuperSecretoDaEterniza0123456789";
const USER = "17841438494434121"; // @eternizacards
const ENV = { PUBLICAR_SECRET: SEGREDO, IG_ACCESS_TOKEN_ETERNIZA: TOKEN };
const T0 = Date.parse("2026-11-15T12:00:00.000Z");
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
    send(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
  };
}

function fakeReq({ method = "POST", body, auth = `Bearer ${SEGREDO}`, query, headers = {} } = {}) {
  return {
    method,
    body,
    query: query || {},
    url: "/",
    headers: { host: "manywata.vercel.app", ...(auth ? { authorization: auth } : {}), ...headers },
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

const corpoCarrossel = (extra = {}) => ({
  conta: "eterniza",
  tipo: "CAROUSEL",
  itens: URLS.map((url) => ({ url })),
  legenda: "Sua carta, seu nome, seu ataque. #tcg #eternizacards",
  ...extra,
});

function rascunhoValido(extra = {}) {
  return assinarRascunho(
    {
      v: 1,
      conta: "eterniza",
      tipo: "CAROUSEL",
      containerId: "1003",
      itens: URLS,
      legenda: "Legenda <script>alert(1)</script> & #tcg",
      criadoEm: new Date(T0).toISOString(),
      expiraEm: new Date(T0 + 24 * 3600 * 1000).toISOString(),
      ...extra,
    },
    SEGREDO
  );
}

async function rodar(rota, req, opcoes = {}) {
  const res = fakeRes();
  await rota(req, res, opcoes);
  return res;
}

// ── Autenticação e método ─────────────────────────────────────────────────

describe("autenticação e método", () => {
  test.each([
    ["rascunho", rotaRascunho, "POST"],
    ["publicar", rotaPublicar, "POST"],
    ["preview", rotaPreview, "GET"],
  ])("%s: sem PUBLICAR_SECRET → 503 e zero fetch", async (_n, rota, method) => {
    const { fetch } = meta();
    const res = await rodar(
      rota,
      fakeReq({ method, body: corpoCarrossel(), query: { id: rascunhoValido() } }),
      { env: { IG_ACCESS_TOKEN_ETERNIZA: TOKEN }, fetch }
    );
    expect(res.statusCode).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("PUBLICAR_SECRET curto demais → 503", async () => {
    const { fetch } = meta();
    const res = await rodar(rotaRascunho, fakeReq({ body: corpoCarrossel(), auth: "Bearer curto" }), {
      env: { ...ENV, PUBLICAR_SECRET: "curto" },
      fetch,
    });
    expect(res.statusCode).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    ["sem header", null],
    ["segredo errado", "Bearer segredo-errado-com-bem-mais-de-32-caracteres!!"],
    ["sem o prefixo Bearer", SEGREDO],
  ])("rascunho e publicar: %s → 401 e zero fetch", async (_n, auth) => {
    const { fetch } = meta();
    const r1 = await rodar(rotaRascunho, fakeReq({ body: corpoCarrossel(), auth }), { env: ENV, fetch });
    const r2 = await rodar(rotaPublicar, fakeReq({ body: { id: rascunhoValido(), confirmar: true }, auth }), {
      env: ENV,
      fetch,
      now: () => T0,
    });
    expect(r1.statusCode).toBe(401);
    expect(r2.statusCode).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    [rotaRascunho, "GET"],
    [rotaRascunho, "PUT"],
    [rotaPublicar, "GET"],
    [rotaPreview, "POST"],
  ])("método errado → 405", async (rota, method) => {
    const { fetch } = meta();
    const res = await rodar(rota, fakeReq({ method, body: corpoCarrossel() }), { env: ENV, fetch });
    expect(res.statusCode).toBe(405);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── Validação ─────────────────────────────────────────────────────────────

describe("validação do carrossel (400, zero fetch)", () => {
  const url = (i) => ({ url: `https://cdn.exemplo.com/s-${i}.jpg` });
  test.each([
    ["1 item", { itens: [url(1)] }, /2 a 10/],
    ["11 itens", { itens: Array.from({ length: 11 }, (_, i) => url(i)) }, /2 a 10/],
    ["itens não é lista", { itens: "a,b" }, /lista/],
    ["http", { itens: [url(1), { url: "http://cdn.exemplo.com/s.jpg" }] }, /https/],
    ["png", { itens: [url(1), { url: "https://cdn.exemplo.com/s.png" }] }, /JPEG/],
    ["localhost", { itens: [url(1), { url: "https://localhost/s.jpg" }] }, /não é público/],
    ["IP privado", { itens: [url(1), { url: "https://192.168.0.10/s.jpg" }] }, /não é público/],
    ["legenda longa", { legenda: "a".repeat(2201) }, /2201 caracteres/],
    ["31 hashtags", { legenda: Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ") }, /31 hashtags/],
    ["tipo desconhecido", { tipo: "FOTO" }, /desconhecido/],
    ["conta inexistente", { conta: "naoexiste" }, /não existe/],
  ])("%s", async (_n, extra, msg) => {
    const { fetch } = meta();
    const res = await rodar(rotaRascunho, fakeReq({ body: corpoCarrossel(extra) }), { env: ENV, fetch });
    expect(res.statusCode).toBe(400);
    expect(res.body.erro).toMatch(msg);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("legenda com exatamente 2200 caracteres e 30 hashtags passa", () => {
    const tags = Array.from({ length: 30 }, (_, i) => `#t${i}`).join(" ");
    const texto = tags + " " + "a".repeat(2200 - tags.length - 1);
    expect(validarLegenda(texto)).toHaveLength(2200);
  });

  test("corpo que não é JSON → 400", async () => {
    const { fetch } = meta();
    const res = await rodar(rotaRascunho, fakeReq({ body: "{nao é json" }), { env: ENV, fetch });
    expect(res.statusCode).toBe(400);
  });

  test("token da conta ausente → 503 claro e zero fetch", async () => {
    const { fetch } = meta();
    const res = await rodar(rotaRascunho, fakeReq({ body: corpoCarrossel() }), {
      env: { PUBLICAR_SECRET: SEGREDO },
      fetch,
    });
    expect(res.statusCode).toBe(503);
    expect(res.body.erro).toMatch(/IG_ACCESS_TOKEN_ETERNIZA/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each(["REELS", "STORIES", "reels"])("tipo %s → 501 e zero fetch", async (tipo) => {
    const { fetch } = meta();
    const res = await rodar(rotaRascunho, fakeReq({ body: corpoCarrossel({ tipo }) }), { env: ENV, fetch });
    expect(res.statusCode).toBe(501);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("registro de tipos: só CAROUSEL implementado", () => {
    expect(Object.keys(TIPOS)).toEqual(["CAROUSEL", "REELS", "STORIES"]);
    expect(TIPOS.CAROUSEL.implementado).toBe(true);
    expect(TIPOS.REELS.implementado).toBe(false);
    expect(TIPOS.STORIES.implementado).toBe(false);
  });
});

// ── Rascunho ──────────────────────────────────────────────────────────────

describe("rascunho (fluxo feliz)", () => {
  test("cria filhos na ordem, espera FINISHED, cria o CAROUSEL e devolve id assinado", async () => {
    const { fetch, chamadas } = meta();
    const rel = relogio();
    const res = await rodar(rotaRascunho, fakeReq({ body: corpoCarrossel() }), { env: ENV, fetch, ...rel });

    expect(res.statusCode).toBe(201);
    const resumo = chamadas.map((c) => `${c.metodo} ${c.caminho}`);
    expect(resumo).toEqual([
      `POST ${USER}/media`,
      `POST ${USER}/media`,
      `POST ${USER}/media`,
      "GET 1000",
      "GET 1001",
      "GET 1002",
      `POST ${USER}/media`,
      "GET 1003",
    ]);
    // filhos: is_carousel_item + image_url na ordem dos slides
    expect(chamadas.slice(0, 3).map((c) => c.params)).toEqual(
      URLS.map((url) => ({ image_url: url, is_carousel_item: true }))
    );
    // carrossel: children na mesma ordem, com legenda
    expect(chamadas[6].params).toEqual({
      media_type: "CAROUSEL",
      children: "1000,1001,1002",
      caption: "Sua carta, seu nome, seu ataque. #tcg #eternizacards",
    });
    // token só no header, nunca na URL
    for (const c of chamadas) {
      expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.url).not.toContain("access_token");
      expect(c.url.startsWith("https://graph.instagram.com/v21.0/")).toBe(true);
    }
    // nada de media_publish no rascunho
    expect(resumo.some((r) => r.includes("media_publish"))).toBe(false);

    const dados = lerRascunho(res.body.id, SEGREDO, T0);
    expect(dados).toMatchObject({ v: 1, conta: "eterniza", tipo: "CAROUSEL", containerId: "1003", itens: URLS });
    expect(Date.parse(dados.expiraEm) - Date.parse(dados.criadoEm)).toBe(24 * 3600 * 1000);
    expect(res.body.preview).toBe(`https://manywata.vercel.app/api/midia/preview?id=${res.body.id}`);
    expect(res.body.containerId).toBe("1003");
  });

  test("filho com status ERROR → 502 claro e o CAROUSEL não é criado", async () => {
    const { fetch, chamadas } = meta({ status: (id) => (id === "1001" ? "ERROR" : "FINISHED") });
    const res = await rodar(rotaRascunho, fakeReq({ body: corpoCarrossel() }), { env: ENV, fetch, ...relogio() });
    expect(res.statusCode).toBe(502);
    expect(res.body.erro).toMatch(/1001.*ERROR/);
    expect(chamadas.filter((c) => c.params.media_type === "CAROUSEL")).toHaveLength(0);
  });

  test("status IN_PROGRESS para sempre → 504 dentro do orçamento, sem esperar de verdade", async () => {
    const { fetch } = meta({ status: () => "IN_PROGRESS" });
    const rel = relogio();
    const res = await rodar(rotaRascunho, fakeReq({ body: corpoCarrossel() }), {
      env: ENV,
      fetch,
      ...rel,
      orcamentoMs: 10_000,
      intervaloMs: 2_000,
    });
    expect(res.statusCode).toBe(504);
    expect(res.body.erro).toMatch(/não ficou pronto/);
    expect(rel.t - T0).toBeLessThanOrEqual(10_000);
    expect(rel.sleep).toHaveBeenCalled();
  });

  test("container EXPIRED durante o polling → 410", async () => {
    const { fetch } = meta({ status: () => "EXPIRED" });
    const res = await rodar(rotaRascunho, fakeReq({ body: corpoCarrossel() }), { env: ENV, fetch, ...relogio() });
    expect(res.statusCode).toBe(410);
  });

  test("Graph recusa a criação → 502 com a mensagem do Meta", async () => {
    const { fetch } = meta({ falhar: { [`POST ${USER}/media`]: "Only photo or video can be accepted as media type." } });
    const res = await rodar(rotaRascunho, fakeReq({ body: corpoCarrossel() }), { env: ENV, fetch, ...relogio() });
    expect(res.statusCode).toBe(502);
    expect(res.body.erro).toMatch(/Only photo or video/);
  });
});

// ── Id assinado ───────────────────────────────────────────────────────────

describe("id do rascunho (token assinado)", () => {
  test("ida e volta", () => {
    const dados = lerRascunho(rascunhoValido(), SEGREDO, T0);
    expect(dados.containerId).toBe("1003");
  });

  test("corpo adulterado (outro containerId) → 401", () => {
    const [, sig] = rascunhoValido().split(".");
    const outro = Buffer.from(JSON.stringify({ v: 1, conta: "eterniza", tipo: "CAROUSEL", containerId: "666", itens: [], expiraEm: "2099-01-01T00:00:00Z" })).toString("base64url");
    expect(() => lerRascunho(`${outro}.${sig}`, SEGREDO, T0)).toThrow(expect.objectContaining({ status: 401 }));
  });

  test("assinado com outro segredo → 401", () => {
    const id = assinarRascunho({ v: 1 }, "outro-segredo-com-bem-mais-de-32-caracteres");
    expect(() => lerRascunho(id, SEGREDO, T0)).toThrow(expect.objectContaining({ status: 401 }));
  });

  test.each([undefined, "", "semponto", "a.b.c", "<script>.x"])("malformado %j → 400", (id) => {
    expect(() => lerRascunho(id, SEGREDO, T0)).toThrow(expect.objectContaining({ status: 400 }));
  });

  test("expirado → 410", () => {
    expect(() => lerRascunho(rascunhoValido(), SEGREDO, T0 + 24 * 3600 * 1000 + 1)).toThrow(
      expect.objectContaining({ status: 410 })
    );
  });
});

// ── Publicar ──────────────────────────────────────────────────────────────

describe("publicar", () => {
  test.each([
    ["ausente", {}],
    ["string 'true'", { confirmar: "true" }],
    ["número 1", { confirmar: 1 }],
    ["false", { confirmar: false }],
  ])("confirmar %s → 400 e zero fetch", async (_n, extra) => {
    const { fetch } = meta();
    const res = await rodar(rotaPublicar, fakeReq({ body: { id: rascunhoValido(), ...extra } }), {
      env: ENV,
      fetch,
      now: () => T0,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.erro).toMatch(/confirmar: true/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("id adulterado → 401 e zero fetch", async () => {
    const { fetch } = meta();
    const id = rascunhoValido();
    const adulterado = id.slice(0, -2) + (id.endsWith("AA") ? "BB" : "AA");
    const res = await rodar(rotaPublicar, fakeReq({ body: { id: adulterado, confirmar: true } }), {
      env: ENV,
      fetch,
      now: () => T0,
    });
    expect(res.statusCode).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("rascunho expirado → 410 sem chamar a API", async () => {
    const { fetch } = meta();
    const res = await rodar(rotaPublicar, fakeReq({ body: { id: rascunhoValido(), confirmar: true } }), {
      env: ENV,
      fetch,
      now: () => T0 + 25 * 3600 * 1000,
    });
    expect(res.statusCode).toBe(410);
    expect(res.body.erro).toMatch(/container expirado, gere outro rascunho/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("limite atingido → 429 e NÃO chama media_publish", async () => {
    const { fetch, chamadas } = meta({ quota: 50, total: 50 });
    const res = await rodar(rotaPublicar, fakeReq({ body: { id: rascunhoValido(), confirmar: true } }), {
      env: ENV,
      fetch,
      ...relogio(),
    });
    expect(res.statusCode).toBe(429);
    expect(res.body.erro).toMatch(/50\/50/);
    expect(chamadas.some((c) => c.caminho.endsWith("media_publish"))).toBe(false);
  });

  test("limite sem quota_total usa 50 como padrão", async () => {
    const { chamadas } = meta();
    const fetch = vi.fn(async (url, init = {}) => {
      chamadas.push(url);
      const body = url.includes("content_publishing_limit") ? { data: [{ quota_usage: 50 }] } : { status_code: "FINISHED" };
      return { ok: true, status: 200, json: async () => body };
    });
    const res = await rodar(rotaPublicar, fakeReq({ body: { id: rascunhoValido(), confirmar: true } }), {
      env: ENV,
      fetch,
      ...relogio(),
    });
    expect(res.statusCode).toBe(429);
  });

  test("container já PUBLISHED → 409 sem media_publish", async () => {
    const { fetch, chamadas } = meta({ status: () => "PUBLISHED" });
    const res = await rodar(rotaPublicar, fakeReq({ body: { id: rascunhoValido(), confirmar: true } }), {
      env: ENV,
      fetch,
      ...relogio(),
    });
    expect(res.statusCode).toBe(409);
    expect(chamadas.some((c) => c.caminho.endsWith("media_publish"))).toBe(false);
  });

  test("fluxo feliz: re-checa status, checa limite, publica e devolve permalink", async () => {
    const { fetch, chamadas } = meta({ quota: 3 });
    const res = await rodar(rotaPublicar, fakeReq({ body: { id: rascunhoValido(), confirmar: true } }), {
      env: ENV,
      fetch,
      ...relogio(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      publicado: true,
      mediaId: "9001",
      permalink: "https://www.instagram.com/p/ABC123/",
      conta: "eterniza",
      tipo: "CAROUSEL",
      quota: { usado: 4, total: 50 },
    });
    expect(chamadas.map((c) => `${c.metodo} ${c.caminho}`)).toEqual([
      "GET 1003",
      `GET ${USER}/content_publishing_limit`,
      `POST ${USER}/media_publish`,
      "GET 9001",
    ]);
    expect(chamadas[1].params.fields).toBe("quota_usage,config");
    expect(chamadas[2].params).toEqual({ creation_id: "1003" });
  });

  test("permalink falhou depois de publicar → 200 com aviso (não induz republicar)", async () => {
    const { fetch } = meta({ falhar: { "GET 9001?permalink": "temporariamente indisponível" } });
    const res = await rodar(rotaPublicar, fakeReq({ body: { id: rascunhoValido(), confirmar: true } }), {
      env: ENV,
      fetch,
      ...relogio(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.publicado).toBe(true);
    expect(res.body.permalink).toBeNull();
    expect(res.body.aviso).toMatch(/permalink/);
  });
});

// ── Aliases /api/carrossel/* (arquivos de rota de verdade) ────────────────

describe("aliases /api/carrossel/*", () => {
  beforeEach(() => {
    vi.stubEnv("PUBLICAR_SECRET", SEGREDO);
    vi.stubEnv("IG_ACCESS_TOKEN_ETERNIZA", TOKEN);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("rascunho sem 'tipo' assume CAROUSEL", async () => {
    const { fetch } = meta();
    vi.stubGlobal("fetch", fetch);
    const { tipo, ...semTipo } = corpoCarrossel();
    const res = fakeRes();
    await aliasRascunho(fakeReq({ body: semTipo }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.tipo).toBe("CAROUSEL");
  });

  test("rascunho com tipo REELS no alias de carrossel → 400 e zero fetch", async () => {
    const { fetch } = meta();
    vi.stubGlobal("fetch", fetch);
    const res = fakeRes();
    await aliasRascunho(fakeReq({ body: corpoCarrossel({ tipo: "REELS" }) }), res);
    expect(res.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("publicar no alias recusa rascunho de outro tipo", async () => {
    const { fetch } = meta();
    vi.stubGlobal("fetch", fetch);
    const res = fakeRes();
    await aliasPublicar(fakeReq({ body: { id: rascunhoValido({ tipo: "REELS", expiraEm: "2099-01-01T00:00:00.000Z" }), confirmar: true } }), res);
    expect(res.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── Preview ───────────────────────────────────────────────────────────────

describe("preview", () => {
  test("mostra os slides na ordem e a legenda escapada, sem nenhuma ação de publicar", async () => {
    const { fetch } = meta();
    const res = await rodar(rotaPreview, fakeReq({ method: "GET", auth: null, query: { id: rascunhoValido() } }), {
      env: ENV,
      fetch,
      now: () => T0,
    });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    const srcs = [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs).toEqual(URLS);
    expect(html).toContain("Legenda &lt;script&gt;alert(1)&lt;/script&gt; &amp; #tcg");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<form|<button|publicar"/i);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("aceita o Bearer certo; Bearer errado → 401", async () => {
    const ok = await rodar(rotaPreview, fakeReq({ method: "GET", query: { id: rascunhoValido() } }), { env: ENV, now: () => T0 });
    expect(ok.statusCode).toBe(200);
    const ruim = await rodar(
      rotaPreview,
      fakeReq({ method: "GET", auth: "Bearer errado", query: { id: rascunhoValido() } }),
      { env: ENV, now: () => T0 }
    );
    expect(ruim.statusCode).toBe(401);
  });

  test("id adulterado → 401; expirado → 410; sem id → 400", async () => {
    const opt = { env: ENV, now: () => T0 };
    const id = rascunhoValido();
    const adulterado = await rodar(rotaPreview, fakeReq({ method: "GET", auth: null, query: { id: "x" + id } }), opt);
    expect(adulterado.statusCode).toBe(401);
    const expirado = await rodar(rotaPreview, fakeReq({ method: "GET", auth: null, query: { id } }), {
      env: ENV,
      now: () => T0 + 25 * 3600 * 1000,
    });
    expect(expirado.statusCode).toBe(410);
    const semId = await rodar(rotaPreview, fakeReq({ method: "GET", auth: null }), opt);
    expect(semId.statusCode).toBe(400);
  });
});

// ── Token nunca vaza ──────────────────────────────────────────────────────

describe("o access token nunca aparece em resposta, erro ou log", () => {
  let espioes;
  beforeEach(() => {
    espioes = ["log", "warn", "error", "info"].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  });
  afterEach(() => vi.restoreAllMocks());

  const tudoQueFoiLogado = () => espioes.flatMap((s) => s.mock.calls.flat()).map(String).join("\n");

  test("fluxos feliz e de erro, inclusive com o Graph ecoando o token", async () => {
    const respostas = [];
    const eco = `Invalid OAuth access token - https://graph.instagram.com/x?access_token=${TOKEN} (token ${TOKEN})`;

    // rascunho feliz
    let m = meta();
    respostas.push(await rodar(rotaRascunho, fakeReq({ body: corpoCarrossel() }), { env: ENV, fetch: m.fetch, ...relogio() }));
    const id = respostas[0].body.id;
    // id assinado não carrega o token
    expect(Buffer.from(id.split(".")[0], "base64url").toString()).not.toContain(TOKEN);

    // Graph ecoando o token no erro, na criação e no publish
    m = meta({ falhar: { [`POST ${USER}/media`]: eco } });
    respostas.push(await rodar(rotaRascunho, fakeReq({ body: corpoCarrossel() }), { env: ENV, fetch: m.fetch, ...relogio() }));
    m = meta({ falhar: { [`POST ${USER}/media_publish`]: eco } });
    respostas.push(await rodar(rotaPublicar, fakeReq({ body: { id, confirmar: true } }), { env: ENV, fetch: m.fetch, ...relogio() }));
    m = meta({ falhar: { "GET 9001?permalink": eco } });
    respostas.push(await rodar(rotaPublicar, fakeReq({ body: { id, confirmar: true } }), { env: ENV, fetch: m.fetch, ...relogio() }));

    // falha de rede com o token na mensagem
    const fetchQuebrado = vi.fn(async () => { throw new TypeError(`fetch failed: ${eco}`); });
    respostas.push(await rodar(rotaRascunho, fakeReq({ body: corpoCarrossel() }), { env: ENV, fetch: fetchQuebrado, ...relogio() }));

    // erro inesperado (não-ErroHttp) carregando o token
    const fetchBizarro = vi.fn(async () => ({
      status: 200,
      json: async () => ({}),
      get ok() { throw new Error(`explodiu com ${TOKEN}`); },
    }));
    respostas.push(await rodar(rotaRascunho, fakeReq({ body: corpoCarrossel() }), { env: ENV, fetch: fetchBizarro, ...relogio() }));

    expect(respostas.map((r) => r.statusCode)).toEqual([201, 502, 502, 200, 502, 500]);
    expect(respostas[5].body.erro).toMatch(/erro interno/);
    expect(respostas[1].body.erro).toContain("access_token=[oculto]");
    for (const r of respostas) {
      const texto = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
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

// ── CLI (partes puras) ────────────────────────────────────────────────────

describe("scripts/midia.mjs", () => {
  test("listarSlides: ordem numérica e só slide-NN.jpg", () => {
    const pasta = mkdtempSync(join(tmpdir(), "render-"));
    try {
      for (const nome of ["slide-10.jpg", "slide-2.jpg", "slide-01.jpg", "capa.png", "slide-03.png", "instagram-post.txt"]) {
        writeFileSync(join(pasta, nome), "");
      }
      expect(listarSlides(pasta)).toEqual(["slide-01.jpg", "slide-2.jpg", "slide-10.jpg"]);
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  });

  test("montarUrls: junta base + nome, com ou sem barra final", () => {
    expect(montarUrls("https://cdn.exemplo.com/c1", ["slide-01.jpg"])).toEqual(["https://cdn.exemplo.com/c1/slide-01.jpg"]);
    expect(montarUrls("https://cdn.exemplo.com/c1/", ["slide 02.jpg"])).toEqual(["https://cdn.exemplo.com/c1/slide%2002.jpg"]);
  });

  test("montarUrls: recusa base http", () => {
    expect(() => montarUrls("http://cdn.exemplo.com/", ["a.jpg"])).toThrow(/https/);
  });
});
