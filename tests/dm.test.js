// DMs do @eternizacards: gravação, resposta automática e travas.
// fetch falso: nenhum teste chama Meta, Supabase nem OpenRouter de verdade.
// O Supabase é um PostgREST de mentira em memória (filtros, upsert, PATCH
// condicional), pra trava atômica e idempotência se comportarem como no banco.

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import handler, { processEvents } from "../api/webhook.js";
import { CONTAS, contaPorSlug } from "../api/contas.js";
import { confiancaMinima, maxPorJanela, autoRespostaLigada, TRAVA_MS } from "../api/_lib/dm.js";
import { lerManual, MODELO_PADRAO, OPENROUTER_URL, modeloAgente } from "../api/_lib/dm-llm.js";
import { lerCredenciaisBanco } from "../api/_lib/dm-banco.js";
import {
  classificarEvento,
  contexto,
  lerRespostaModelo,
  montarTurno,
  preChecagem,
  quantidadeDeCartas,
  travasDoTexto,
  LINK_PEDIDO,
  normalizar,
} from "../api/_lib/dm-regras.js";

// ── Constantes ────────────────────────────────────────────────────────────

const GRAPH = "https://graph.instagram.com/v21.0";
const ETERNIZA = "17841438494434121";
const WATANABE = "17841400866194604";
const IGSID = "1122334455667788";
const SUPA = "https://projeto-teste.supabase.co";

const TOKEN = "token-falso-eterniza-so-para-teste-1234567890";
const TOKEN_WATANABE = "token-falso-watanabe-so-para-teste-1234567890";
const CHAVE_DB = "chave-falsa-service-role-so-para-teste-1234567890";
const CHAVE_LLM = "chave-falsa-openrouter-so-para-teste-1234567890";

// segunda 16/11/2026 15:00 BRT
const T0 = Date.parse("2026-11-16T15:00:00-03:00");
const HORA = 3600_000;

const ENV_BASE = { DM_SUPABASE_URL: SUPA, DM_SUPABASE_SERVICE_ROLE_KEY: CHAVE_DB, OPENROUTER_API_KEY: CHAVE_LLM };
const ENV_LIGADO = { ...ENV_BASE, DM_AUTO_RESPOSTA: "1" };

const TEXTO_OK = "O Trio sai por R$ 99,90 com frete grátis pro Brasil todo 😊";
const RESPOSTA_OK = { acao: "responder", texto: TEXTO_OK, motivo: "", confianca: 0.92 };

const REGRA_QUERO = contaPorSlug("eterniza").regras.find((r) => r.keyword === "quero");

// ── Payloads ──────────────────────────────────────────────────────────────

const entrada = (mid, texto, { ts = T0 - 1000, igsid = IGSID, message = {} } = {}) => ({
  sender: { id: igsid },
  recipient: { id: ETERNIZA },
  timestamp: ts,
  message: { mid, ...(texto != null ? { text: texto } : {}), ...message },
});

const eco = (mid, texto, { ts = T0, igsid = IGSID } = {}) => ({
  sender: { id: ETERNIZA },
  recipient: { id: igsid },
  timestamp: ts,
  message: { mid, text: texto, is_echo: true },
});

const payloadDm = (...eventos) => ({ object: "instagram", entry: [{ id: ETERNIZA, time: T0, messaging: eventos }] });

const mudancaComentario = (id = "c1", texto = "Quero!") => ({
  field: "comments",
  value: { id, text: texto, from: { id: "999000111", username: "fulano" }, media: { id: "midia1" } },
});

const payloadComentario = () => ({ object: "instagram", entry: [{ id: ETERNIZA, time: T0, changes: [mudancaComentario()] }] });

// ── PostgREST falso ───────────────────────────────────────────────────────

const json = (status, corpo) =>
  new Response(corpo === undefined ? null : JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

const PADRAO = {
  ig_dm_conversas: {
    conta: "eterniza", ultima_entrada_em: null, ultima_saida_em: null,
    humano: false, humano_motivo: null, humano_em: null,
    pausada_manual: false, pausada_motivo: null, pausada_em: null,
    respondendo_ate: null, trava_id: null, auto_respostas_janela: 0, janela_inicio_em: null,
    ultima_auto_texto: null, ultima_auto_em: null,
  },
  ig_dm_mensagens: { texto: null, tipo: "texto", origem: null },
  ig_dm_log: {},
};
const UNICO = { ig_dm_conversas: "igsid", ig_dm_mensagens: "mid" };
const CHECAGENS = {
  ig_dm_mensagens: (l) =>
    ["entrada", "saida_auto", "eco_manual"].includes(l.direcao) &&
    ["texto", "imagem", "video", "audio", "arquivo", "compartilhamento", "story", "anexo", "nao_suportado"].includes(l.tipo ?? "texto") &&
    [null, undefined, "cliente", "llm", "comentario", "vinicius"].includes(l.origem) &&
    !!l.mid && !!l.enviada_em,
  ig_dm_log: (l) => ["resposta", "humano", "erro_envio", "bloqueio"].includes(l.tipo),
  ig_dm_conversas: (l) => !!l.igsid,
};

function comparar(v, op, alvo) {
  if (op === "is") return alvo === "null" ? v == null : String(v) === alvo;
  if (op === "eq") return v != null && String(v) === alvo;
  if (op === "neq") return v == null || String(v) !== alvo;
  if (v == null) return false;
  const numerico = !Number.isNaN(Number(alvo));
  const [x, y] = numerico ? [Number(v), Number(alvo)] : [Date.parse(v), Date.parse(alvo)];
  if (op === "lt") return x < y;
  if (op === "lte") return x <= y;
  if (op === "gt") return x > y;
  if (op === "gte") return x >= y;
  throw new Error(`operador não suportado no fake: ${op}`);
}

function filtroDe(params) {
  const fs = [];
  for (const [k, v] of params) {
    if (["select", "order", "limit", "on_conflict"].includes(k)) continue;
    if (k === "or") {
      const partes = v.replace(/^\(|\)$/g, "").split(",").map((p) => {
        const [col, op, ...resto] = p.split(".");
        return { col, op, alvo: resto.join(".") };
      });
      fs.push((l) => partes.some((p) => comparar(l[p.col], p.op, p.alvo)));
    } else {
      const [op, ...resto] = v.split(".");
      fs.push((l) => comparar(l[k], op, resto.join(".")));
    }
  }
  return (l) => fs.every((f) => f(l));
}

function bancoFalso() {
  const t = { ig_dm_conversas: [], ig_dm_mensagens: [], ig_dm_log: [] };
  let seq = 0;
  const estado = { falha: null };
  const copia = (x) => JSON.parse(JSON.stringify(x));

  function responder(url, metodo, init) {
    const u = new URL(url);
    const tabela = u.pathname.replace("/rest/v1/", "");
    const linhas = t[tabela];
    if (!linhas) return json(404, { message: `tabela ${tabela}` });
    if (init.headers?.apikey !== CHAVE_DB || init.headers?.Authorization !== `Bearer ${CHAVE_DB}`) {
      return json(401, { message: "sem chave" });
    }
    if (estado.falha?.(tabela, metodo)) return json(500, { message: `falha simulada; chave=${CHAVE_DB}` });
    const p = u.searchParams;
    const prefer = init.headers?.Prefer || "";
    const representacao = prefer.includes("return=representation");
    const casa = filtroDe(p);

    if (metodo === "GET") {
      let r = linhas.filter(casa);
      const ordem = p.get("order");
      if (ordem) {
        const chaves = ordem.split(",").map((o) => o.split("."));
        r = [...r].sort((a, b) => {
          for (const [col, dir] of chaves) {
            const x = a[col], y = b[col];
            if (x === y) continue;
            const menor = typeof x === "number" ? x < y : String(x) < String(y);
            return (menor ? -1 : 1) * (dir === "desc" ? -1 : 1);
          }
          return 0;
        });
      }
      if (p.get("limit")) r = r.slice(0, Number(p.get("limit")));
      return json(200, copia(r));
    }

    if (metodo === "POST") {
      const itens = JSON.parse(init.body);
      const conflito = p.get("on_conflict");
      const saida = [];
      for (const item of itens) {
        const existente = conflito ? linhas.find((l) => l[conflito] === item[conflito]) : UNICO[tabela] && linhas.find((l) => l[UNICO[tabela]] === item[UNICO[tabela]]);
        if (existente) {
          if (prefer.includes("resolution=ignore-duplicates")) continue;
          if (prefer.includes("resolution=merge-duplicates")) {
            Object.assign(existente, item);
            saida.push(existente);
            continue;
          }
          return json(409, { code: "23505", message: "duplicate key" });
        }
        if (!CHECAGENS[tabela](item)) return json(400, { code: "23514", message: `check violado em ${tabela}: ${JSON.stringify(item)}` });
        if (tabela === "ig_dm_mensagens" && !t.ig_dm_conversas.some((c) => c.igsid === item.igsid)) {
          return json(409, { code: "23503", message: "FK ig_dm_mensagens.igsid" });
        }
        seq++;
        const linha = { ...PADRAO[tabela], id: seq, criado_em: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(), ...item };
        linhas.push(linha);
        saida.push(linha);
      }
      return representacao ? json(201, copia(saida)) : new Response(null, { status: 201 });
    }

    if (metodo === "PATCH") {
      const campos = JSON.parse(init.body);
      const alvo = linhas.filter(casa);
      for (const l of alvo) Object.assign(l, campos);
      return representacao ? json(200, copia(alvo)) : new Response(null, { status: 204 });
    }
    return json(405, {});
  }

  return {
    t,
    estado,
    responder,
    conversa: (igsid = IGSID) => t.ig_dm_conversas.find((c) => c.igsid === igsid),
    mensagens: (igsid = IGSID) => t.ig_dm_mensagens.filter((m) => m.igsid === igsid),
    log: (tipo) => t.ig_dm_log.filter((l) => !tipo || l.tipo === tipo),
    semear(tabela, campos) {
      seq++;
      const linha = { ...PADRAO[tabela], id: seq, criado_em: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(), ...campos };
      t[tabela].push(linha);
      return linha;
    },
  };
}

// ── fetch falso (Meta + Supabase + OpenRouter) ────────────────────────────

const conteudoLlm = (r) => (typeof r === "string" ? r : JSON.stringify(r));

function ambiente({ llm = RESPOSTA_OK, graph } = {}) {
  const db = bancoFalso();
  const chamadas = [];
  let saidas = 0;
  const fetch = vi.fn(async (url, init = {}) => {
    const u = String(url);
    const metodo = init.method || "GET";
    chamadas.push({ url: u, metodo, init, corpo: init.body ? JSON.parse(init.body) : undefined });
    await Promise.resolve(); // deixa execuções simultâneas se intercalarem
    if (u.startsWith(`${SUPA}/rest/v1/`)) return db.responder(u, metodo, init);
    if (u === OPENROUTER_URL) {
      const corpo = JSON.parse(init.body);
      const n = chamadas.filter((c) => c.url === OPENROUTER_URL).length;
      const r = typeof llm === "function" ? await llm(corpo, n) : llm;
      if (r instanceof Response) return r;
      return json(200, { choices: [{ message: { content: conteudoLlm(r) } }], usage: { cost: 0.0021 }, model: MODELO_PADRAO });
    }
    if (u === `${GRAPH}/me/messages`) {
      const corpo = JSON.parse(init.body);
      if (corpo.recipient?.comment_id) return json(200, { recipient_id: "x", message_id: "m_dm_comentario" });
      if (graph) {
        const r = await graph(corpo);
        if (r) return r;
      }
      saidas++;
      return json(200, { recipient_id: corpo.recipient.id, message_id: `m_saida_${saidas}` });
    }
    if (/\/replies$/.test(u)) return json(200, { id: "resposta_publica_1" });
    throw new Error(`rede de verdade não: ${u}`);
  });
  return {
    db,
    fetch,
    chamadas,
    envios: () => chamadas.filter((c) => c.url === `${GRAPH}/me/messages` && c.corpo?.recipient?.id),
    llms: () => chamadas.filter((c) => c.url === OPENROUTER_URL),
    supa: () => chamadas.filter((c) => c.url.startsWith(SUPA)),
  };
}

let amb;
const rodar = (payload, env = ENV_BASE, agora = T0) => processEvents(payload, { env, now: () => agora });

function logsDoConsole() {
  return [console.log, console.warn, console.error].flatMap((f) => f.mock.calls.map((c) => c.map(String).join(" "))).join("\n");
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("IG_ACCESS_TOKEN_ETERNIZA", TOKEN);
  vi.stubEnv("IG_ACCESS_TOKEN", TOKEN_WATANABE);
  amb = ambiente();
  vi.stubGlobal("fetch", amb.fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const usarAmbiente = (opcoes) => {
  amb = ambiente(opcoes);
  vi.stubGlobal("fetch", amb.fetch);
  return amb;
};

// ── Handler de verdade (process.env + fetch global) ───────────────────────

async function chamarWebhook(payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  const req = Readable.from([raw]);
  req.method = "POST";
  req.query = {};
  req.headers = {};
  if (process.env.IG_APP_SECRET) {
    req.headers["x-hub-signature-256"] = "sha256=" + createHmac("sha256", process.env.IG_APP_SECRET).update(raw).digest("hex");
  }
  const res = {
    statusCode: 0,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
  };
  await handler(req, res);
  return res;
}

// ══════════════════════════════════════════════════════════════════════════
// Gravação
// ══════════════════════════════════════════════════════════════════════════

describe("gravação das DMs", () => {
  test("DM de texto da eterniza: grava conversa e mensagem de entrada (IGSID, texto, timestamp, mid)", async () => {
    await rodar(payloadDm(entrada("m_in_1", "Oi, quanto custa?", { ts: T0 - 5000 })));
    expect(amb.db.conversa()).toMatchObject({ igsid: IGSID, conta: "eterniza", ultima_entrada_em: new Date(T0 - 5000).toISOString() });
    expect(amb.db.mensagens()).toEqual([
      expect.objectContaining({
        mid: "m_in_1", igsid: IGSID, texto: "Oi, quanto custa?", tipo: "texto",
        direcao: "entrada", origem: "cliente", enviada_em: new Date(T0 - 5000).toISOString(),
      }),
    ]);
  });

  test("anexo sem texto: texto null e tipo do anexo (desconhecido vira 'anexo')", async () => {
    await rodar(payloadDm(
      entrada("m_foto", null, { message: { attachments: [{ type: "image", payload: { url: "https://x" } }] } }),
      entrada("m_audio", null, { message: { attachments: [{ type: "audio", payload: {} }] } }),
      entrada("m_outro", null, { message: { attachments: [{ type: "coisa_nova", payload: {} }] } }),
    ));
    const porMid = Object.fromEntries(amb.db.mensagens().map((m) => [m.mid, m]));
    expect(porMid.m_foto).toMatchObject({ texto: null, tipo: "imagem" });
    expect(porMid.m_audio).toMatchObject({ texto: null, tipo: "audio" });
    expect(porMid.m_outro).toMatchObject({ texto: null, tipo: "anexo" });
  });

  test("read, reaction, message_edit, postback e mensagem apagada: ignorados sem tocar no banco", async () => {
    await rodar(payloadDm(
      { sender: { id: IGSID }, recipient: { id: ETERNIZA }, timestamp: T0, read: { mid: "m1" } },
      { sender: { id: IGSID }, recipient: { id: ETERNIZA }, timestamp: T0, reaction: { mid: "m1", action: "react", reaction: "love" } },
      { sender: { id: IGSID }, recipient: { id: ETERNIZA }, timestamp: T0, message_edit: { mid: "m1", text: "x", num_edit: 1 } },
      { sender: { id: IGSID }, recipient: { id: ETERNIZA }, timestamp: T0, postback: { mid: "m2", title: "Botão", payload: "X" } },
      { sender: { id: IGSID }, recipient: { id: ETERNIZA }, timestamp: T0, message: { mid: "m3", is_deleted: true } },
      { sender: { id: IGSID }, recipient: { id: ETERNIZA }, timestamp: T0 },
    ), ENV_LIGADO);
    expect(amb.fetch).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  test("messaging de outra conta (watanabe): ignorado, zero fetch", async () => {
    await rodar({ object: "instagram", entry: [{ id: WATANABE, time: T0, messaging: [entrada("m_w", "oi")] }] }, ENV_LIGADO);
    expect(amb.fetch).not.toHaveBeenCalled();
  });

  test("idempotência: a mesma DM entregue duas vezes grava uma vez e responde uma vez", async () => {
    const p = payloadDm(entrada("m_dup", "Quanto custa o trio?"));
    await rodar(p, ENV_LIGADO);
    await rodar(p, ENV_LIGADO);
    expect(amb.db.mensagens().filter((m) => m.direcao === "entrada")).toHaveLength(1);
    expect(amb.llms()).toHaveLength(1);
    expect(amb.envios()).toHaveLength(1);
    expect(amb.db.log("resposta")).toHaveLength(1);
  });

  test("sem envs do banco: console.warn, zero fetch, e o webhook responde 200", async () => {
    vi.stubEnv("DM_SUPABASE_URL", "");
    vi.stubEnv("DM_SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("DM_AUTO_RESPOSTA", "1");
    const res = await chamarWebhook(payloadDm(entrada("m1", "oi", { ts: Date.now() })));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("EVENT_RECEIVED");
    expect(amb.fetch).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/DM_SUPABASE_URL\/DM_SUPABASE_SERVICE_ROLE_KEY não configurados/));
  });

  test("erro do banco: webhook responde 200 e o log não tem a service role key", async () => {
    vi.stubEnv("DM_SUPABASE_URL", SUPA);
    vi.stubEnv("DM_SUPABASE_SERVICE_ROLE_KEY", CHAVE_DB);
    amb.db.estado.falha = () => true;
    const res = await chamarWebhook(payloadDm(entrada("m1", "oi", { ts: Date.now() })));
    expect(res.statusCode).toBe(200);
    expect(console.error).toHaveBeenCalled();
    const logs = logsDoConsole();
    expect(logs).toMatch(/supabase POST ig_dm_conversas 500/);
    expect(logs).not.toContain(CHAVE_DB);
    expect(logs).not.toContain(TOKEN);
  });

  test("headers do PostgREST: apikey + Bearer da service role, upsert idempotente pelo mid", async () => {
    await rodar(payloadDm(entrada("m1", "oi")));
    const insercao = amb.supa().find((c) => c.url.includes("/ig_dm_mensagens") && c.metodo === "POST");
    expect(insercao.url).toBe(`${SUPA}/rest/v1/ig_dm_mensagens?on_conflict=mid`);
    expect(insercao.init.headers).toMatchObject({
      apikey: CHAVE_DB,
      Authorization: `Bearer ${CHAVE_DB}`,
      Prefer: "resolution=ignore-duplicates,return=representation",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Comentário→DM continua igual
// ══════════════════════════════════════════════════════════════════════════

// As chamadas que o comentário→DM sempre fez (copiadas do código antigo).
const CHAMADAS_COMENTARIO = [
  [
    `${GRAPH}/me/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ recipient: { comment_id: "c1" }, message: { text: REGRA_QUERO.dm } }),
    },
  ],
  [
    `${GRAPH}/c1/replies`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ message: REGRA_QUERO.publicReply }),
    },
  ],
];

describe("comentário→DM inalterado", () => {
  test.each([
    ["chave desligada", ENV_BASE],
    ["chave ligada", ENV_LIGADO],
    ["sem envs de DM", {}],
  ])("payload só de comentário (%s): exatamente as mesmas 2 chamadas, na mesma ordem", async (_n, env) => {
    await rodar(payloadComentario(), env);
    expect(amb.fetch.mock.calls).toEqual(CHAMADAS_COMENTARIO);
  });

  test("pelo handler de verdade: mesmas chamadas e 200", async () => {
    vi.stubEnv("DM_SUPABASE_URL", SUPA);
    vi.stubEnv("DM_SUPABASE_SERVICE_ROLE_KEY", CHAVE_DB);
    vi.stubEnv("DM_AUTO_RESPOSTA", "1");
    const res = await chamarWebhook(payloadComentario());
    expect(res.statusCode).toBe(200);
    expect(amb.fetch.mock.calls).toEqual(CHAMADAS_COMENTARIO);
  });

  test("payload misto (changes + messaging): comentário primeiro, igual, depois a DM", async () => {
    const p = payloadComentario();
    p.entry[0].messaging = [entrada("m_misto", "Quanto custa o trio?")];
    await rodar(p, ENV_LIGADO);
    expect(amb.fetch.mock.calls.slice(0, 2)).toEqual(CHAMADAS_COMENTARIO);
    expect(amb.envios()).toHaveLength(1);
    expect(amb.db.mensagens().map((m) => m.mid)).toContain("m_misto");
  });

  test("banco e LLM fora do ar: o comentário→DM sai igual e nada lança", async () => {
    usarAmbiente({ llm: () => json(500, { error: "fora" }) });
    amb.db.estado.falha = () => true;
    const p = payloadComentario();
    p.entry[0].messaging = [entrada("m_x", "oi")];
    await expect(rodar(p, ENV_LIGADO)).resolves.toBeUndefined();
    expect(amb.fetch.mock.calls.slice(0, 2)).toEqual(CHAMADAS_COMENTARIO);
  });

  test("LLM fora do ar (banco ok): comentário→DM igual, DM gravada, nada enviado", async () => {
    usarAmbiente({ llm: () => json(503, { error: "indisponível" }) });
    const p = payloadComentario();
    p.entry[0].messaging = [entrada("m_y", "Quanto custa o trio?")];
    await rodar(p, ENV_LIGADO);
    expect(amb.fetch.mock.calls.slice(0, 2)).toEqual(CHAMADAS_COMENTARIO);
    expect(amb.envios()).toHaveLength(0);
    expect(amb.db.log("bloqueio")).toEqual([expect.objectContaining({ motivo: "erro_llm" })]);
    expect(amb.db.conversa().humano).toBe(false);
  });

  test("erro inesperado dentro da DM não impede a próxima entry", async () => {
    amb.db.estado.falha = (tabela) => tabela === "ig_dm_conversas";
    const p = payloadDm(entrada("m1", "oi"));
    p.entry.push({ id: ETERNIZA, time: T0, changes: [mudancaComentario()] });
    await rodar(p, ENV_LIGADO);
    expect(amb.fetch.mock.calls.filter(([u]) => u.startsWith(GRAPH))).toEqual(CHAMADAS_COMENTARIO);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Chave DM_AUTO_RESPOSTA
// ══════════════════════════════════════════════════════════════════════════

describe("chave DM_AUTO_RESPOSTA", () => {
  test.each([undefined, "", "0", "true", "sim", " 2 "])("DM_AUTO_RESPOSTA=%s: grava, não chama o LLM nem envia", async (valor) => {
    await rodar(payloadDm(entrada("m1", "Quanto custa o trio?")), { ...ENV_BASE, DM_AUTO_RESPOSTA: valor });
    expect(amb.db.mensagens()).toHaveLength(1);
    expect(amb.llms()).toHaveLength(0);
    expect(amb.envios()).toHaveLength(0);
    expect(amb.chamadas.some((c) => c.url.startsWith(GRAPH))).toBe(false);
  });

  test("autoRespostaLigada só com '1'", () => {
    expect(autoRespostaLigada({})).toBe(false);
    expect(autoRespostaLigada({ DM_AUTO_RESPOSTA: "1" })).toBe(true);
    expect(autoRespostaLigada({ DM_AUTO_RESPOSTA: "true" })).toBe(false);
  });

  test("ligada sem OPENROUTER_API_KEY: grava, avisa, não envia", async () => {
    await rodar(payloadDm(entrada("m1", "Quanto custa o trio?")), { ...ENV_LIGADO, OPENROUTER_API_KEY: "" });
    expect(amb.db.mensagens()).toHaveLength(1);
    expect(amb.llms()).toHaveLength(0);
    expect(amb.envios()).toHaveLength(0);
    expect(amb.db.log("bloqueio")).toEqual([expect.objectContaining({ motivo: "sem_chave_llm" })]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Resposta automática
// ══════════════════════════════════════════════════════════════════════════

describe("resposta automática ligada", () => {
  test("exatamente 1 POST /me/messages pro IGSID, com o token da eterniza, e log 'resposta'", async () => {
    await rodar(payloadDm(entrada("m_in", "Quanto custa o trio?")), ENV_LIGADO);
    const envios = amb.envios();
    expect(envios).toHaveLength(1);
    expect(envios[0].corpo).toEqual({ recipient: { id: IGSID }, message: { text: TEXTO_OK } });
    expect(envios[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(envios[0].url).not.toContain(TOKEN);

    expect(amb.db.mensagens().find((m) => m.direcao === "saida_auto")).toMatchObject({
      mid: "m_saida_1", texto: TEXTO_OK, origem: "llm", tipo: "texto",
    });
    expect(amb.db.log("resposta")).toEqual([
      expect.objectContaining({
        igsid: IGSID, mid_entrada: "m_in", mid_saida: "m_saida_1", texto: TEXTO_OK,
        modelo: MODELO_PADRAO, custo_usd: 0.0021, confianca: 0.92,
      }),
    ]);
    const c = amb.db.conversa();
    expect(c).toMatchObject({ humano: false, auto_respostas_janela: 1, janela_inicio_em: new Date(T0).toISOString(), respondendo_ate: null, trava_id: null });
  });

  test("chamada ao OpenRouter: mesmo modelo/params do painel, manual inteiro no system + contexto do Instagram", async () => {
    await rodar(payloadDm(entrada("m_in", "Quanto custa o trio?")), ENV_LIGADO);
    const [chamada] = amb.llms();
    expect(chamada.init.headers.Authorization).toBe(`Bearer ${CHAVE_LLM}`);
    const corpo = chamada.corpo;
    expect(corpo).toMatchObject({ model: MODELO_PADRAO, temperature: 0.4, max_tokens: 700, usage: { include: true } });
    const [sistema, ...resto] = corpo.messages;
    expect(sistema.role).toBe("system");
    expect(sistema.content.startsWith(lerManual())).toBe(true);
    expect(sistema.content).toContain("Direct do Instagram");
    expect(sistema.content).toContain("seg. 16/11/2026 15:00");
    expect(sistema.content).toContain("Black Friday: NÃO está ativa");
    expect(sistema.content).toContain(LINK_PEDIDO);
    expect(resto).toEqual([{ role: "user", content: "Quanto custa o trio?" }]);
  });

  test("OPENROUTER_MODELO_AGENTE troca o modelo", async () => {
    await rodar(payloadDm(entrada("m_in", "oi")), { ...ENV_LIGADO, OPENROUTER_MODELO_AGENTE: "outro/modelo" });
    expect(amb.llms()[0].corpo.model).toBe("outro/modelo");
    expect(modeloAgente({})).toBe("deepseek/deepseek-v4.1-flash-1017");
  });

  test("histórico vai junto: mensagens anteriores como user/assistant, turno novo por último", async () => {
    await rodar(payloadDm(entrada("m1", "Oi!")), ENV_LIGADO);
    await rodar(payloadDm(entrada("m2", "E quanto tempo demora?")), ENV_LIGADO);
    const msgs = amb.llms()[1].corpo.messages.slice(1);
    expect(msgs).toEqual([
      { role: "user", content: "Oi!" },
      { role: "assistant", content: TEXTO_OK },
      { role: "user", content: "E quanto tempo demora?" },
    ]);
    expect(amb.envios()).toHaveLength(2);
  });

  test("várias mensagens seguidas na mesma entrega viram um turno só e uma resposta", async () => {
    await rodar(payloadDm(entrada("m1", "Oi"), entrada("m2", "quanto custa o trio?")), ENV_LIGADO);
    expect(amb.llms()).toHaveLength(1);
    expect(amb.llms()[0].corpo.messages.at(-1)).toEqual({ role: "user", content: "Oi\nquanto custa o trio?" });
    expect(amb.envios()).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Passar pra humano
// ══════════════════════════════════════════════════════════════════════════

function esperaHumano(motivo) {
  expect(amb.envios()).toHaveLength(0);
  const c = amb.db.conversa();
  expect(c.humano).toBe(true);
  expect(c.humano_motivo).toBe(motivo);
  expect(c.humano_em).toBe(new Date(T0).toISOString());
  expect(amb.db.log("humano")).toEqual([expect.objectContaining({ igsid: IGSID, motivo })]);
}

describe("pré-checagem: humano sem chamar o LLM", () => {
  test.each([
    ["reclamação", "Péssimo atendimento, quero reclamar", "reclamacao"],
    ["carta danificada", "A carta chegou amassada", "reclamacao"],
    ["cancelamento", "Quero cancelar meu pedido", "cancelamento"],
    ["pagamento", "Paguei ontem e não confirmou", "pagamento"],
    ["cartão recusado", "meu cartão recusado, e agora?", "pagamento"],
    ["entrega", "Cadê meu pedido? Não chegou ainda", "entrega"],
    ["rastreio", "me passa o código de rastreio", "entrega"],
    ["25 cartas", "Quero fazer 25 cartas pra festa", "quantidade"],
    ["trinta cartas por extenso", "dá pra fazer trinta cartas?", "quantidade"],
  ])("%s → humano (%s)", async (_n, texto, motivo) => {
    await rodar(payloadDm(entrada("m1", texto)), ENV_LIGADO);
    expect(amb.llms()).toHaveLength(0);
    esperaHumano(motivo);
  });

  test("depois de humano, a próxima mensagem não chama o LLM nem envia", async () => {
    await rodar(payloadDm(entrada("m1", "Quero cancelar")), ENV_LIGADO);
    await rodar(payloadDm(entrada("m2", "Quanto custa o trio?")), ENV_LIGADO);
    expect(amb.llms()).toHaveLength(0);
    expect(amb.envios()).toHaveLength(0);
    expect(amb.db.mensagens()).toHaveLength(2);
  });
});

describe("decisão do modelo e travas no texto", () => {
  test.each([
    ["o modelo pede humano", { acao: "humano", texto: "", motivo: "COTAÇÃO", confianca: 0.9 }, "modelo:COTAÇÃO"],
    ["confiança abaixo do mínimo", { ...RESPOSTA_OK, confianca: 0.5 }, "confianca_baixa"],
    ["JSON quebrado", '{"acao": "responder", "texto": "oi"', "llm_invalido"],
    ["sem JSON", "Claro! O trio custa R$ 99,90", "llm_invalido"],
    ["acao desconhecida", { ...RESPOSTA_OK, acao: "talvez" }, "llm_invalido"],
    ["confiança fora de 0..1", { ...RESPOSTA_OK, confianca: 7 }, "llm_invalido"],
    ["texto vazio", { ...RESPOSTA_OK, texto: "   " }, "texto_vazio"],
    ["telefone no texto", { ...RESPOSTA_OK, texto: "Me chama no zap (11) 98765-4321" }, "telefone"],
    ["sequência de 8+ dígitos", { ...RESPOSTA_OK, texto: "Fala com a gente: 11987654321" }, "telefone"],
    ["Black Friday antes de 24/11", { ...RESPOSTA_OK, texto: "Na Black Friday vai ter 5 cartas por R$ 99,90!" }, "black_friday"],
    ["acima de 1000 bytes", { ...RESPOSTA_OK, texto: "á".repeat(501) }, "tamanho"],
    ["preço fora do manual", { ...RESPOSTA_OK, texto: "Trio + Única sai R$ 139,80" }, "preco_fora_do_manual"],
    ["prazo somado", { ...RESPOSTA_OK, texto: "Fica pronto em 7 dias úteis" }, "prazo_fora_do_manual"],
    ["link de fora", { ...RESPOSTA_OK, texto: "Olha aqui: https://bit.ly/xyz" }, "link_fora_do_manual"],
  ])("%s → humano, nada enviado", async (_n, resposta, motivo) => {
    usarAmbiente({ llm: resposta });
    await rodar(payloadDm(entrada("m1", "Quanto custa o trio?")), ENV_LIGADO);
    expect(amb.llms()).toHaveLength(1);
    esperaHumano(motivo);
    expect(amb.db.log("humano")[0]).toMatchObject({ mid_entrada: "m1", modelo: MODELO_PADRAO, custo_usd: 0.0021 });
  });

  test("DM_AUTO_CONFIANCA_MIN muda o limiar", async () => {
    usarAmbiente({ llm: { ...RESPOSTA_OK, confianca: 0.5 } });
    await rodar(payloadDm(entrada("m1", "Quanto custa o trio?")), { ...ENV_LIGADO, DM_AUTO_CONFIANCA_MIN: "0.4" });
    expect(amb.envios()).toHaveLength(1);
  });

  test("Black Friday depois de 24/11 00:00 BRT: permitido e o contexto diz que está ativa", async () => {
    const texto = "Na Black Friday são 5 cartas por R$ 99,90 com frete grátis 😊";
    usarAmbiente({ llm: { ...RESPOSTA_OK, texto } });
    const agora = Date.parse("2026-11-25T10:00:00-03:00");
    await rodar(payloadDm(entrada("m1", "tem promoção?", { ts: agora - 1000 })), ENV_LIGADO, agora);
    expect(amb.envios()).toHaveLength(1);
    expect(amb.envios()[0].corpo.message.text).toBe(texto);
    expect(amb.llms()[0].corpo.messages[0].content).toContain("Black Friday: ATIVA agora");
  });

  test("texto com exatamente 1000 bytes sai", async () => {
    const texto = "a".repeat(1000);
    usarAmbiente({ llm: { ...RESPOSTA_OK, texto } });
    await rodar(payloadDm(entrada("m1", "Quanto custa o trio?")), ENV_LIGADO);
    expect(amb.envios()).toHaveLength(1);
  });

  test("ELOGIO: responde normal (não é humano)", async () => {
    usarAmbiente({ llm: { acao: "responder", texto: "Que mensagem linda, muito obrigado! 🥹", motivo: "ELOGIO", confianca: 0.95 } });
    await rodar(payloadDm(entrada("m1", "Vocês são incríveis!")), ENV_LIGADO);
    expect(amb.envios()).toHaveLength(1);
    expect(amb.db.conversa().humano).toBe(false);
    expect(amb.db.log("resposta")[0].motivo).toBe("ELOGIO");
  });

  test("conversa já com humano: não chama o LLM nem envia", async () => {
    amb.db.semear("ig_dm_conversas", { igsid: IGSID, humano: true, humano_motivo: "reclamacao" });
    await rodar(payloadDm(entrada("m1", "Quanto custa o trio?")), ENV_LIGADO);
    expect(amb.db.mensagens()).toHaveLength(1);
    expect(amb.llms()).toHaveLength(0);
    expect(amb.envios()).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Eco (is_echo)
// ══════════════════════════════════════════════════════════════════════════

describe("eco", () => {
  test("eco manual do Vinicius: pausa a conversa e a automação não responde depois", async () => {
    await rodar(payloadDm(eco("m_vini", "Oi! Aqui é o Vini 😊")), ENV_LIGADO);
    expect(amb.db.conversa()).toMatchObject({ pausada_manual: true, pausada_motivo: "vinicius_respondeu", pausada_em: new Date(T0).toISOString() });
    expect(amb.db.mensagens()).toEqual([expect.objectContaining({ mid: "m_vini", direcao: "eco_manual", origem: "vinicius" })]);
    expect(amb.db.log("humano")).toEqual([expect.objectContaining({ motivo: "vinicius_respondeu" })]);

    await rodar(payloadDm(entrada("m_cli", "Quanto custa o trio?")), ENV_LIGADO);
    expect(amb.llms()).toHaveLength(0);
    expect(amb.envios()).toHaveLength(0);
  });

  test("eco manual no meio de uma conversa automática: pausa dali em diante", async () => {
    await rodar(payloadDm(entrada("m1", "Oi")), ENV_LIGADO);
    expect(amb.envios()).toHaveLength(1);
    await rodar(payloadDm(eco("m_vini", "Deixa comigo!")), ENV_LIGADO);
    await rodar(payloadDm(entrada("m2", "Beleza")), ENV_LIGADO);
    expect(amb.envios()).toHaveLength(1);
    expect(amb.llms()).toHaveLength(1);
  });

  test("eco do nosso envio (mid já gravado): ignorado, não pausa", async () => {
    await rodar(payloadDm(entrada("m1", "Oi")), ENV_LIGADO);
    await rodar(payloadDm(eco("m_saida_1", TEXTO_OK, { ts: T0 + 60_000 })), ENV_LIGADO, T0 + 60_000);
    expect(amb.db.conversa().pausada_manual).toBe(false);
    await rodar(payloadDm(entrada("m2", "E o prazo?")), ENV_LIGADO, T0 + 120_000);
    expect(amb.envios()).toHaveLength(2);
  });

  test("corrida: o eco do nosso envio chega ANTES de gravarmos o mid → reconhecido pelo texto, não pausa", async () => {
    usarAmbiente({
      graph: async (corpo) => {
        // a Meta entrega o eco enquanto o POST ainda não voltou
        await rodar(payloadDm(eco("m_saida_1", corpo.message.text)), ENV_LIGADO);
      },
    });
    await rodar(payloadDm(entrada("m1", "Oi")), ENV_LIGADO);
    expect(amb.envios()).toHaveLength(1);
    expect(amb.db.conversa().pausada_manual).toBe(false);
    expect(amb.db.mensagens().find((m) => m.mid === "m_saida_1")).toMatchObject({ direcao: "saida_auto", origem: "llm" });
    expect(amb.db.log("humano")).toHaveLength(0);
  });

  test("eco com o mesmo texto da nossa resposta, mas depois de 2 min e mid desconhecido: é manual (pausa)", async () => {
    amb.db.semear("ig_dm_conversas", { igsid: IGSID, ultima_auto_texto: TEXTO_OK, ultima_auto_em: new Date(T0 - 3 * 60_000).toISOString() });
    await rodar(payloadDm(eco("m_x", TEXTO_OK)), ENV_LIGADO);
    expect(amb.db.conversa().pausada_manual).toBe(true);
  });

  test("eco do DM do comentário→DM: gravado como saída automática (origem comentario), não pausa", async () => {
    await rodar(payloadDm(eco("m_dm_comentario", REGRA_QUERO.dm)), ENV_LIGADO);
    expect(amb.db.conversa().pausada_manual).toBe(false);
    expect(amb.db.mensagens()).toEqual([expect.objectContaining({ direcao: "saida_auto", origem: "comentario" })]);
    await rodar(payloadDm(entrada("m1", "Quero o trio!")), ENV_LIGADO);
    expect(amb.envios()).toHaveLength(1);
    // a DM do comentário entra no histórico como fala nossa
    expect(amb.llms()[0].corpo.messages.slice(1, 2)).toEqual([{ role: "assistant", content: REGRA_QUERO.dm }]);
  });

  test("eco reentregue não duplica nem loga de novo", async () => {
    await rodar(payloadDm(eco("m_vini", "Oi")), ENV_LIGADO);
    await rodar(payloadDm(eco("m_vini", "Oi")), ENV_LIGADO);
    expect(amb.db.mensagens()).toHaveLength(1);
    expect(amb.db.log("humano")).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Janela, limite e trava
// ══════════════════════════════════════════════════════════════════════════

describe("janela de 24h", () => {
  test("última mensagem do cliente com mais de 24h: não responde, log 'bloqueio'", async () => {
    await rodar(payloadDm(entrada("m_velha", "oi", { ts: T0 - 25 * HORA })), ENV_LIGADO);
    expect(amb.llms()).toHaveLength(0);
    expect(amb.envios()).toHaveLength(0);
    expect(amb.db.log("bloqueio")).toEqual([expect.objectContaining({ motivo: "fora_da_janela", mid_entrada: "m_velha" })]);
    expect(amb.db.conversa().humano).toBe(false);
  });

  test("23h59: ainda responde", async () => {
    await rodar(payloadDm(entrada("m1", "oi", { ts: T0 - 24 * HORA + 60_000 })), ENV_LIGADO);
    expect(amb.envios()).toHaveLength(1);
  });
});

describe("limite de respostas por janela", () => {
  test("DM_AUTO_MAX_POR_JANELA=2: duas respostas, a terceira mensagem passa pra humano", async () => {
    const env = { ...ENV_LIGADO, DM_AUTO_MAX_POR_JANELA: "2" };
    await rodar(payloadDm(entrada("m1", "Oi")), env);
    await rodar(payloadDm(entrada("m2", "Quanto custa?")), env);
    await rodar(payloadDm(entrada("m3", "E o prazo?")), env);
    expect(amb.envios()).toHaveLength(2);
    expect(amb.llms()).toHaveLength(2);
    esperaHumanoSemZerarEnvios("limite_respostas");
  });

  test("padrão 5", async () => {
    for (let i = 1; i <= 6; i++) await rodar(payloadDm(entrada(`m${i}`, "oi de novo")), ENV_LIGADO);
    expect(amb.envios()).toHaveLength(5);
    expect(amb.db.conversa().humano_motivo).toBe("limite_respostas");
  });

  test("janela vencida (24h depois da primeira resposta): contador recomeça", async () => {
    amb.db.semear("ig_dm_conversas", { igsid: IGSID, auto_respostas_janela: 5, janela_inicio_em: new Date(T0 - 25 * HORA).toISOString() });
    await rodar(payloadDm(entrada("m1", "oi")), ENV_LIGADO);
    expect(amb.envios()).toHaveLength(1);
    expect(amb.db.conversa()).toMatchObject({ auto_respostas_janela: 1, janela_inicio_em: new Date(T0).toISOString() });
  });

  test("leitura das envs de limite e confiança", () => {
    expect(maxPorJanela({})).toBe(5);
    expect(maxPorJanela({ DM_AUTO_MAX_POR_JANELA: "3" })).toBe(3);
    expect(maxPorJanela({ DM_AUTO_MAX_POR_JANELA: "0" })).toBe(5);
    expect(maxPorJanela({ DM_AUTO_MAX_POR_JANELA: "abc" })).toBe(5);
    expect(confiancaMinima({})).toBe(0.7);
    expect(confiancaMinima({ DM_AUTO_CONFIANCA_MIN: "0.85" })).toBe(0.85);
    expect(confiancaMinima({ DM_AUTO_CONFIANCA_MIN: "2" })).toBe(0.7);
    expect(confiancaMinima({ DM_AUTO_CONFIANCA_MIN: "" })).toBe(0.7);
  });
});

function esperaHumanoSemZerarEnvios(motivo) {
  const c = amb.db.conversa();
  expect(c.humano).toBe(true);
  expect(c.humano_motivo).toBe(motivo);
  expect(amb.db.log("humano")).toEqual([expect.objectContaining({ motivo })]);
}

describe("evitar resposta duplicada", () => {
  test("a mesma DM entregue duas vezes AO MESMO TEMPO: 1 envio", async () => {
    const p = payloadDm(entrada("m1", "Quanto custa o trio?"));
    await Promise.all([rodar(p, ENV_LIGADO), rodar(p, ENV_LIGADO)]);
    expect(amb.envios()).toHaveLength(1);
    expect(amb.llms()).toHaveLength(1);
  });

  test("duas DMs diferentes ao mesmo tempo: a trava deixa uma execução só responder, com as duas no turno", async () => {
    await Promise.all([
      rodar(payloadDm(entrada("m1", "Oi")), ENV_LIGADO),
      rodar(payloadDm(entrada("m2", "quanto custa o trio?")), ENV_LIGADO),
    ]);
    expect(amb.envios()).toHaveLength(1);
    expect(amb.llms()).toHaveLength(1);
    expect(amb.llms()[0].corpo.messages.at(-1).content).toBe("Oi\nquanto custa o trio?");
    expect(amb.db.conversa().respondendo_ate).toBeNull();
  });

  test("trava é PATCH condicional com return=representation (livre ou vencida, sem humano, sem pausa)", async () => {
    await rodar(payloadDm(entrada("m1", "oi")), ENV_LIGADO);
    const patch = amb.supa().find((c) => c.metodo === "PATCH" && c.corpo.trava_id);
    const p = new URL(patch.url).searchParams;
    expect(p.get("igsid")).toBe(`eq.${IGSID}`);
    expect(p.get("humano")).toBe("is.false");
    expect(p.get("pausada_manual")).toBe("is.false");
    expect(p.get("or")).toBe(`(respondendo_ate.is.null,respondendo_ate.lt.${new Date(T0).toISOString()})`);
    expect(patch.init.headers.Prefer).toBe("return=representation");
    expect(patch.corpo.respondendo_ate).toBe(new Date(T0 + TRAVA_MS).toISOString());
  });

  test("trava com outra execução (ainda válida): não responde", async () => {
    amb.db.semear("ig_dm_conversas", { igsid: IGSID, respondendo_ate: new Date(T0 + 30_000).toISOString(), trava_id: "outra" });
    await rodar(payloadDm(entrada("m1", "oi")), ENV_LIGADO);
    expect(amb.llms()).toHaveLength(0);
    expect(amb.envios()).toHaveLength(0);
  });

  test("trava vencida (função morreu no meio): pega e responde", async () => {
    amb.db.semear("ig_dm_conversas", { igsid: IGSID, respondendo_ate: new Date(T0 - 1000).toISOString(), trava_id: "morta" });
    await rodar(payloadDm(entrada("m1", "oi")), ENV_LIGADO);
    expect(amb.envios()).toHaveLength(1);
  });

  test("cliente manda outra mensagem durante o envio: quem tem a trava responde ela em seguida", async () => {
    let primeiro = true;
    usarAmbiente({
      graph: async () => {
        if (primeiro) {
          primeiro = false;
          // chega com a trava ocupada: essa execução desiste, a outra cobre
          await rodar(payloadDm(entrada("m2", "e quanto tempo demora?")), ENV_LIGADO);
        }
      },
    });
    await rodar(payloadDm(entrada("m1", "Quanto custa o trio?")), ENV_LIGADO);
    expect(amb.envios()).toHaveLength(2);
    expect(amb.llms().map((c) => c.corpo.messages.at(-1).content)).toEqual(["Quanto custa o trio?", "e quanto tempo demora?"]);
    expect(amb.db.conversa().auto_respostas_janela).toBe(2);
  });

  test("reentrega de uma mensagem já respondida: não responde de novo", async () => {
    amb.db.semear("ig_dm_conversas", { igsid: IGSID });
    amb.db.semear("ig_dm_mensagens", { mid: "m1", igsid: IGSID, texto: "oi", tipo: "texto", direcao: "entrada", origem: "cliente", enviada_em: new Date(T0 - 5000).toISOString() });
    amb.db.semear("ig_dm_mensagens", { mid: "m_resp", igsid: IGSID, texto: "Olá!", tipo: "texto", direcao: "saida_auto", origem: "llm", enviada_em: new Date(T0 - 4000).toISOString() });
    await rodar(payloadDm(entrada("m1", "oi")), ENV_LIGADO);
    expect(amb.llms()).toHaveLength(0);
    expect(amb.envios()).toHaveLength(0);
  });

  test("cliente manda outra mensagem enquanto o LLM pensa: refaz com as duas e envia 1 resposta", async () => {
    usarAmbiente({
      llm: async (_corpo, n) => {
        if (n === 1) await rodar(payloadDm(entrada("m2", "é pra presente")), ENV_LIGADO);
        return RESPOSTA_OK;
      },
    });
    await rodar(payloadDm(entrada("m1", "Quanto custa o trio?")), ENV_LIGADO);
    expect(amb.llms()).toHaveLength(2);
    expect(amb.llms()[1].corpo.messages.at(-1).content).toBe("Quanto custa o trio?\né pra presente");
    expect(amb.envios()).toHaveLength(1);
  });

  test("o Vinicius responde enquanto o LLM pensa: não envia", async () => {
    usarAmbiente({
      llm: async () => {
        await rodar(payloadDm(eco("m_vini", "Deixa que eu respondo")), ENV_LIGADO);
        return RESPOSTA_OK;
      },
    });
    await rodar(payloadDm(entrada("m1", "Quanto custa o trio?")), ENV_LIGADO);
    expect(amb.envios()).toHaveLength(0);
    expect(amb.db.log("bloqueio")).toEqual([expect.objectContaining({ motivo: "pausada_durante" })]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Falha no envio e sanitização
// ══════════════════════════════════════════════════════════════════════════

describe("falha no envio", () => {
  test("Graph recusa: log 'erro_envio' sanitizado (sem token), nada gravado como saída", async () => {
    usarAmbiente({
      graph: async () => json(400, { error: { message: `Invalid OAuth access token. access_token=${TOKEN} Bearer ${TOKEN}`, code: 190 } }),
    });
    await rodar(payloadDm(entrada("m1", "Quanto custa o trio?")), ENV_LIGADO);
    expect(amb.envios()).toHaveLength(1);
    const [erro] = amb.db.log("erro_envio");
    expect(erro).toMatchObject({ igsid: IGSID, mid_entrada: "m1", texto: TEXTO_OK });
    expect(erro.detalhe).toMatch(/Graph 400/);
    expect(erro.detalhe).not.toContain(TOKEN);
    expect(JSON.stringify(amb.db.t)).not.toContain(TOKEN);
    expect(logsDoConsole()).not.toContain(TOKEN);
    expect(amb.db.mensagens().filter((m) => m.direcao === "saida_auto")).toHaveLength(0);
    expect(amb.db.conversa().respondendo_ate).toBeNull();
  });

  test("rede caiu no envio: log 'erro_envio', webhook segue", async () => {
    usarAmbiente({ graph: async () => { throw new Error(`socket hang up ${TOKEN}`); } });
    await expect(rodar(payloadDm(entrada("m1", "oi")), ENV_LIGADO)).resolves.toBeUndefined();
    expect(amb.db.log("erro_envio")[0].detalhe).not.toContain(TOKEN);
  });

  test("erro do OpenRouter não vaza a chave", async () => {
    usarAmbiente({ llm: () => json(401, { error: `chave inválida ${CHAVE_LLM}` }) });
    await rodar(payloadDm(entrada("m1", "oi")), ENV_LIGADO);
    expect(amb.db.log("bloqueio")[0].detalhe).not.toContain(CHAVE_LLM);
    expect(logsDoConsole()).not.toContain(CHAVE_LLM);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Regras puras
// ══════════════════════════════════════════════════════════════════════════

describe("travasDoTexto", () => {
  const antes = T0;
  test.each([
    "O Trio sai por R$ 99,90 com frete grátis 😊",
    "A Carta Única sai por R$ 39,90, e o frete fica entre R$ 8 e R$ 20 na maioria dos CEPs.",
    "Funciona assim: a arte fica pronta em até 3 dias úteis depois que chegam as fotos e o nome. Depois que você aprovar, são 4 dias úteis de produção. O frete leva de 3 a 7 dias.",
    "A carta tem 63x88mm, o tamanho oficial.",
    `É só fazer o pedido por aqui: ${LINK_PEDIDO}`,
    "Nosso site é https://eternizacards.com.br",
    "Hoje é 16/11/2026 às 15:00.",
    "Blackout? Não, tá tudo certo",
  ])("passa: %s", (texto) => {
    expect(travasDoTexto(texto, antes)).toBeNull();
  });

  test.each([
    ["Black Friday em 23/11 23:59", Date.parse("2026-11-23T23:59:59-03:00"), "black_friday"],
    ["blackfriday junto", Date.parse("2026-11-20T10:00:00-03:00"), "black_friday"],
    ["Black Friday em 01/12 00:00", Date.parse("2026-12-01T00:00:00-03:00"), "black_friday"],
  ])("bloqueia: %s", (_n, agora, motivo) => {
    expect(travasDoTexto("Aproveita a Black Friday! ou blackfriday", agora)?.motivo).toBe(motivo);
  });

  test("Black Friday no limite: 24/11 00:00 e 30/11 23:59 BRT passam", () => {
    expect(travasDoTexto("Black Friday: 5 cartas por R$ 99,90", Date.parse("2026-11-24T00:00:00-03:00"))).toBeNull();
    expect(travasDoTexto("Black Friday: 5 cartas por R$ 99,90", Date.parse("2026-11-30T23:59:00-03:00"))).toBeNull();
  });

  test.each([
    ["+55 11 98765-4321", "telefone"],
    ["987.654.321", "telefone"],
    ["R$ 49,90", "preco_fora_do_manual"],
    ["R$ 1.000,00", "preco_fora_do_manual"],
    ["48 horas úteis", "prazo_fora_do_manual"],
    ["5 dias úteis", "prazo_fora_do_manual"],
    ["www.outrosite.com", "link_fora_do_manual"],
    ["https://eternizacards.com.br/?cupom=100", "link_fora_do_manual"],
  ])("bloqueia: %s → %s", (texto, motivo) => {
    expect(travasDoTexto(texto, antes)?.motivo).toBe(motivo);
  });

  test("1000 bytes UTF-8 (não caracteres)", () => {
    expect(travasDoTexto("é".repeat(500), antes)).toBeNull(); // 1000 bytes
    expect(travasDoTexto("é".repeat(501), antes)?.motivo).toBe("tamanho");
  });
});

describe("preChecagem", () => {
  test.each([
    "Quanto custa o trio?",
    "Pode ser foto do meu cachorro?",
    "Quero fazer 20 cartas pra lembrancinha",
    "vinte cartas dá?",
    "Como funciona o prazo?",
    "Oi",
    "",
  ])("não pede humano: %s", (texto) => {
    expect(preChecagem(texto)).toBeNull();
  });

  test("quantidade de cartas", () => {
    expect(quantidadeDeCartas(normalizar("quero 21 cartas"))).toBe(21);
    expect(quantidadeDeCartas(normalizar("uns 30cards"))).toBe(30);
    expect(quantidadeDeCartas(normalizar("vinte e cinco cartas"))).toBe(21);
    expect(quantidadeDeCartas(normalizar("3 cartas"))).toBe(3);
  });
});

describe("lerRespostaModelo", () => {
  test("aceita JSON cercado de ```json", () => {
    expect(lerRespostaModelo('```json\n{"acao":"responder","texto":" oi ","motivo":"","confianca":0.8}\n```')).toEqual({
      ok: true, acao: "responder", texto: "oi", motivo: "", confianca: 0.8,
    });
  });
  test.each(["", "null", "[1,2]", '{"acao":"responder","texto":"oi"}', '{"acao":"x","confianca":0.9}'])("inválido: %s", (c) => {
    expect(lerRespostaModelo(c).ok).toBe(false);
  });
});

describe("classificarEvento e montarTurno", () => {
  test("entrada usa sender.id; eco usa recipient.id", () => {
    expect(classificarEvento(entrada("m1", "oi"), ETERNIZA)).toMatchObject({ tipo: "entrada", igsid: IGSID, mid: "m1", texto: "oi", tipoMsg: "texto" });
    expect(classificarEvento(eco("m2", "oi"), ETERNIZA)).toMatchObject({ tipo: "eco", igsid: IGSID, mid: "m2" });
  });

  test("mensagem da própria conta sem is_echo é ignorada", () => {
    expect(classificarEvento({ sender: { id: ETERNIZA }, recipient: { id: IGSID }, message: { mid: "m", text: "x" } }, ETERNIZA)).toBeNull();
  });

  test("turno com foto e áudio", () => {
    expect(montarTurno([
      { tipo: "imagem", texto: null },
      { tipo: "texto", texto: "essa é a Bia" },
      { tipo: "audio", texto: null },
    ])).toBe("[o cliente mandou uma foto]\nessa é a Bia\n[o cliente mandou um áudio, que você não consegue ouvir: peça com carinho pra escrever o que disse no áudio]");
  });

  test("contexto fora do horário humano diz quando o Vini volta", () => {
    const sabado = new Date(Date.parse("2026-11-21T22:00:00-03:00"));
    expect(contexto(sabado)).toContain("fechado, volta segunda a partir das 8h");
    expect(contexto(new Date(T0))).toContain("aberto agora");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Arquivos: manual, vercel.json, migração
// ══════════════════════════════════════════════════════════════════════════

describe("arquivos", () => {
  test("manual copiado do painel, com a origem no cabeçalho e as regras que as travas checam", () => {
    const m = lerManual();
    expect(m).toMatch(/^<!--[\s\S]*eternizacards-painel[\s\S]*dc6e271[\s\S]*-->/);
    expect(m).toContain("# Manual do agente de atendimento — EternizaCards");
    expect(m).toContain("| Carta Única | 1 | R$ 39,90 |");
    expect(m).toContain("| Trio Colecionável | 3 | R$ 99,90 |");
    expect(m).toContain("só de 24/11/2026 00:00 a 30/11/2026 23:59 BRT");
    expect(m).toContain("arte em até **3 dias úteis**");
    expect(m).toContain("produção em **4 dias úteis**");
  });

  test("vercel.json: webhook com maxDuration 60 e o manual incluído na função", () => {
    const cfg = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    expect(cfg.functions["api/webhook.js"]).toEqual({ maxDuration: 60, includeFiles: "docs/agente-whatsapp-manual.md" });
    // a trava vence depois que a função já morreu
    expect(TRAVA_MS).toBeGreaterThan(cfg.functions["api/webhook.js"].maxDuration * 1000);
  });

  test("migração: 3 tabelas ig_dm_, RLS ligada, sem policy, sem acesso de anon/authenticated", () => {
    const dir = new URL("../supabase/migrations/", import.meta.url);
    const sql = readFileSync(new URL("20261116190000_ig_dm.sql", dir), "utf8");
    for (const t of ["ig_dm_conversas", "ig_dm_mensagens", "ig_dm_log"]) {
      expect(sql).toContain(`create table if not exists public.${t}`);
      expect(sql).toContain(`alter table public.${t} enable row level security;`);
    }
    expect(sql).not.toMatch(/create\s+policy/i);
    expect(sql).toMatch(/revoke all on table public\.ig_dm_conversas, public\.ig_dm_mensagens, public\.ig_dm_log from anon, authenticated;/);
    expect(sql).toMatch(/mid\s+text not null unique/);
    expect(sql).toMatch(/igsid\s+text not null unique/);
    expect(sql).toContain("check (direcao in ('entrada', 'saida_auto', 'eco_manual'))");
    expect(sql).toContain("check (tipo in ('resposta', 'humano', 'erro_envio', 'bloqueio'))");
  });

  test("credenciais do banco: só https e as duas envs", () => {
    expect(lerCredenciaisBanco({})).toBeNull();
    expect(lerCredenciaisBanco({ DM_SUPABASE_URL: SUPA })).toBeNull();
    expect(lerCredenciaisBanco({ DM_SUPABASE_URL: "http://x.supabase.co", DM_SUPABASE_SERVICE_ROLE_KEY: "k" })).toBeNull();
    expect(lerCredenciaisBanco({ DM_SUPABASE_URL: `${SUPA}/`, DM_SUPABASE_SERVICE_ROLE_KEY: " k " })).toEqual({ url: SUPA, chave: "k" });
  });

  test("só a eterniza atende DM (contas.js inalterado)", () => {
    expect(CONTAS.map((c) => c.slug)).toEqual(["watanabe", "eterniza"]);
  });
});
