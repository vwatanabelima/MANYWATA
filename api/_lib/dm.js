// Resposta automática às DMs do @eternizacards.
//
// O webhook (api/webhook.js) chama processarMessaging() com o entry.messaging
// da conta eterniza, DEPOIS do comentário→DM e dentro de um try próprio.
//
//   1. Grava tudo que chega (ig_dm_mensagens), idempotente pelo mid: a Meta
//      reentrega webhook, e linha que já existia não é processada de novo.
//   2. Com DM_AUTO_RESPOSTA=1 (padrão: desligado, só grava), responde na hora
//      com o LLM (dm-llm.js), o manual como system prompt e as travas de
//      dm-regras.js. Na dúvida passa pra humano: marca a conversa
//      (humano=true) e daí em diante a automação não responde mais ali.
//   3. Eco (is_echo) que não é envio nosso = o Vinicius respondeu pelo app:
//      a conversa fica pausada (pausada_manual) e a automação para ali.
//
// Nada daqui lança pro webhook: erro de banco, LLM ou Meta vira log
// sanitizado e o webhook responde 200 do mesmo jeito.
//
// Tudo é injetável (env, fetch, now, banco, lerManual) pros testes; em
// produção cai em process.env, fetch global e relógio de verdade.

import { randomUUID } from "node:crypto";
import { sanitizar } from "./seguranca.js";
import { criarBanco, lerCredenciaisBanco } from "./dm-banco.js";
import { chamarModelo, lerManual, modeloAgente } from "./dm-llm.js";
import {
  ECO_PROPRIO_MS,
  classificarEvento,
  contexto as blocoContexto,
  janelaAberta,
  JANELA_24H_MS,
  lerRespostaModelo,
  montarTurno,
  preChecagem,
  travasDoTexto,
} from "./dm-regras.js";

const GRAPH = "https://graph.instagram.com/v21.0";

// Só esta conta tem DM gravada/respondida. As outras: messaging ignorado.
export const CONTA_DM = "eterniza";
export const atendeDm = (conta) => conta?.slug === CONTA_DM;

export const MAX_POR_JANELA_PADRAO = 5;
export const CONFIANCA_MIN_PADRAO = 0.7;

// A trava da conversa vale 90s: mais que o maxDuration do webhook (60s), então
// uma função que morreu no meio não segura a conversa pra sempre.
export const TRAVA_MS = 90_000;
// Não começa outra chamada ao LLM depois disto (o LLM tem 25s de timeout e a
// função tem 60s no total).
const ORCAMENTO_LLM_MS = 25_000;
// Voltas dentro da trava (ex.: o cliente mandou outra mensagem enquanto o LLM
// pensava) e tentativas de pegar a trava de novo depois de soltar.
const MAX_VOLTAS = 3;
const MAX_TENTATIVAS = 2;
const HISTORICO = 30;

export const autoRespostaLigada = (env = process.env) => String(env.DM_AUTO_RESPOSTA ?? "").trim() === "1";

export function maxPorJanela(env = process.env) {
  const n = Number(env.DM_AUTO_MAX_POR_JANELA);
  return Number.isInteger(n) && n >= 1 ? n : MAX_POR_JANELA_PADRAO;
}

export function confiancaMinima(env = process.env) {
  const v = String(env.DM_AUTO_CONFIANCA_MIN ?? "").trim();
  const n = Number(v);
  return v && Number.isFinite(n) && n >= 0 && n <= 1 ? n : CONFIANCA_MIN_PADRAO;
}

// ── Entrada ───────────────────────────────────────────────────────────────

export async function processarMessaging(eventos, { conta, token }, opcoes = {}) {
  const env = opcoes.env || process.env;
  const relevantes = (eventos || []).map((ev) => classificarEvento(ev, conta.userId)).filter(Boolean);
  if (!relevantes.length) return; // read, reaction, postback... nada a fazer

  const cred = lerCredenciaisBanco(env);
  if (!cred && !opcoes.banco) {
    console.warn(`[${conta.slug}] dm: DM_SUPABASE_URL/DM_SUPABASE_SERVICE_ROLE_KEY não configurados — ${relevantes.length} DM(s) não gravada(s)`);
    return;
  }
  const fetchFn = opcoes.fetch || globalThis.fetch;
  const ctx = {
    env,
    conta,
    token,
    fetch: fetchFn,
    now: opcoes.now || Date.now,
    lerManual: opcoes.lerManual || lerManual,
    banco: opcoes.banco || criarBanco(cred, fetchFn),
    segredos: [token, cred?.chave, env.OPENROUTER_API_KEY].filter(Boolean),
  };
  ctx.inicio = ctx.now();

  // Primeiro grava tudo da entrega (várias mensagens seguidas do mesmo
  // cliente viram um turno só), depois responde uma vez por conversa.
  const aResponder = new Map(); // igsid → mid da última entrada nova
  for (const e of relevantes) {
    try {
      if (e.tipo === "entrada") {
        if (await gravarEntrada(ctx, e)) aResponder.set(e.igsid, e.mid);
      } else {
        await tratarEco(ctx, e);
      }
    } catch (err) {
      console.error(`[${conta.slug}] dm ${e.tipo} ${e.mid}: ${sanitizar(err?.message || err, ctx.segredos)}`);
    }
  }
  if (!aResponder.size || !autoRespostaLigada(env)) return; // padrão: só grava

  for (const [igsid, mid] of aResponder) {
    try {
      if (!String(env.OPENROUTER_API_KEY ?? "").trim()) {
        console.warn(`[${conta.slug}] dm: DM_AUTO_RESPOSTA=1 mas OPENROUTER_API_KEY não está setado — não respondeu`);
        await registrar(ctx, { tipo: "bloqueio", igsid, mid_entrada: mid, motivo: "sem_chave_llm" });
        continue;
      }
      await responderSePuder(ctx, igsid, mid);
    } catch (err) {
      console.error(`[${conta.slug}] dm resposta ${mid}: ${sanitizar(err?.message || err, ctx.segredos)}`);
    }
  }
}

// Grava a entrada. false = já existia (reentrega): não processa de novo.
async function gravarEntrada(ctx, e) {
  const agoraIso = new Date(ctx.now()).toISOString();
  const emIso = (e.em || new Date(ctx.now())).toISOString();
  // conversa antes da mensagem (a mensagem tem FK pro igsid)
  await ctx.banco.salvarConversa({ igsid: e.igsid, conta: ctx.conta.slug, ultima_entrada_em: emIso, atualizado_em: agoraIso });
  const nova = await ctx.banco.gravarMensagem({
    mid: e.mid, igsid: e.igsid, texto: e.texto, tipo: e.tipoMsg,
    direcao: "entrada", origem: "cliente", enviada_em: emIso,
  });
  if (!nova) {
    console.log(`[${ctx.conta.slug}] dm ${e.mid} já gravada (reentrega) — ignorada`);
    return false;
  }
  console.log(`[${ctx.conta.slug}] dm ${e.mid} gravada (${e.tipoMsg})`);
  return true;
}

// ── Eco (mensagem que saiu da conta) ──────────────────────────────────────

// Texto de uma regra do comentário→DM (o private reply também gera eco).
function ehDmDeComentario(conta, texto) {
  if (!texto) return false;
  return (conta.regras || []).some((r) => r.dm && r.dm.trim() === texto.trim());
}

async function tratarEco(ctx, e) {
  const { banco, conta } = ctx;
  // mid já gravado = envio nosso (gravado logo depois do POST) ou reentrega
  if (await banco.mensagemPorMid(e.mid)) return;

  const agora = ctx.now();
  const agoraIso = new Date(agora).toISOString();
  const emIso = (e.em || new Date(agora)).toISOString();
  const conversa = await banco.conversa(e.igsid);

  // Corrida: o eco do nosso envio pode chegar antes de gravarmos o mid. O
  // texto fica marcado na conversa ANTES do POST; bateu nos últimos 2 min = nosso.
  const ultimoAuto = conversa?.ultima_auto_em ? Date.parse(conversa.ultima_auto_em) : NaN;
  if (
    e.texto && conversa?.ultima_auto_texto &&
    conversa.ultima_auto_texto.trim() === e.texto.trim() &&
    Number.isFinite(ultimoAuto) && agora - ultimoAuto <= ECO_PROPRIO_MS
  ) {
    console.log(`[${conta.slug}] dm eco ${e.mid}: é a nossa resposta automática — ignorado`);
    return;
  }

  if (ehDmDeComentario(conta, e.texto)) {
    await banco.salvarConversa({ igsid: e.igsid, conta: conta.slug, atualizado_em: agoraIso });
    await banco.gravarMensagem({
      mid: e.mid, igsid: e.igsid, texto: e.texto, tipo: e.tipoMsg,
      direcao: "saida_auto", origem: "comentario", enviada_em: emIso,
    });
    return;
  }

  // O Vinicius respondeu pelo app: pausa a automação nessa conversa.
  const jaPausada = !!conversa?.pausada_manual;
  await banco.salvarConversa({
    igsid: e.igsid,
    conta: conta.slug,
    atualizado_em: agoraIso,
    ...(jaPausada ? {} : { pausada_manual: true, pausada_motivo: "vinicius_respondeu", pausada_em: agoraIso }),
  });
  const nova = await banco.gravarMensagem({
    mid: e.mid, igsid: e.igsid, texto: e.texto, tipo: e.tipoMsg,
    direcao: "eco_manual", origem: "vinicius", enviada_em: emIso,
  });
  if (nova && !jaPausada) {
    console.log(`[${conta.slug}] dm ${e.igsid}: Vinicius respondeu pelo app — automação pausada nessa conversa`);
    await registrar(ctx, { tipo: "humano", igsid: e.igsid, motivo: "vinicius_respondeu", detalhe: "eco de mensagem manual" });
  }
}

// ── Resposta automática ───────────────────────────────────────────────────

// Trava atômica: PATCH condicional (só pega quem achar a conversa livre, sem
// humano e sem pausa). Duas entregas ao mesmo tempo → só uma volta com linha.
async function pegarTrava(ctx, igsid) {
  const agora = ctx.now();
  const id = randomUUID();
  const linhas = await ctx.banco.atualizarConversa(
    igsid,
    { respondendo_ate: new Date(agora + TRAVA_MS).toISOString(), trava_id: id },
    {
      humano: "is.false",
      pausada_manual: "is.false",
      or: `(respondendo_ate.is.null,respondendo_ate.lt.${new Date(agora).toISOString()})`,
    }
  );
  return linhas[0] ? { conversa: linhas[0], id } : null;
}

async function soltarTrava(ctx, igsid, id) {
  try {
    await ctx.banco.atualizarConversa(igsid, { respondendo_ate: null, trava_id: null }, { trava_id: `eq.${id}` });
  } catch (err) {
    // expira sozinha em TRAVA_MS
    console.error(`[${ctx.conta.slug}] dm: falhou soltar a trava de ${igsid}: ${sanitizar(err?.message || err, ctx.segredos)}`);
  }
}

async function responderSePuder(ctx, igsid, midGatilho) {
  // entradas já resolvidas nesta execução (respondidas, passadas pra humano
  // ou bloqueadas) ou que já estavam respondidas antes
  const estado = { cobertas: null, midGatilho };
  for (let tentativa = 0; tentativa < MAX_TENTATIVAS; tentativa++) {
    const trava = await pegarTrava(ctx, igsid);
    if (!trava) {
      // outra execução está respondendo (ela cobre esta mensagem), ou a
      // conversa está com humano / pausada
      console.log(`[${ctx.conta.slug}] dm ${midGatilho}: conversa ocupada, com humano ou pausada — não respondeu`);
      return;
    }
    try {
      await responderComTrava(ctx, igsid, trava.conversa, estado);
    } finally {
      await soltarTrava(ctx, igsid, trava.id);
    }
    // Quem chegou enquanto a trava estava com a gente desistiu ao ver a trava;
    // se ficou mensagem sem resposta, pega a trava de novo e responde.
    if (estado.cobertas == null || ctx.now() - ctx.inicio > ORCAMENTO_LLM_MS) return;
    const msgs = await ctx.banco.mensagensRecentes(igsid, HISTORICO);
    if (!turnoPendente(msgs, estado).length) return;
  }
}

// Entradas do cliente que ainda não tiveram resposta. Na primeira leitura:
// as que vêm depois da última mensagem que não é de entrada (só responde se a
// última da conversa ainda é do cliente). Depois: as que ninguém cobriu.
function turnoPendente(msgs, estado) {
  if (estado.cobertas == null) {
    let base = -1;
    msgs.forEach((m, i) => { if (m.direcao !== "entrada") base = i; });
    estado.cobertas = new Set(msgs.slice(0, base + 1).filter((m) => m.direcao === "entrada").map((m) => m.mid));
    return msgs.slice(base + 1);
  }
  return msgs.filter((m) => m.direcao === "entrada" && !estado.cobertas.has(m.mid));
}

function paraLlm(m) {
  if (m.direcao === "entrada") return { role: "user", content: montarTurno([m]) || "[mensagem sem texto]" };
  return { role: "assistant", content: m.texto || "[anexo]" };
}

function limiteAtingido(conversa, max, agora) {
  const inicio = conversa.janela_inicio_em ? Date.parse(conversa.janela_inicio_em) : NaN;
  return Number.isFinite(inicio) && agora - inicio < JANELA_24H_MS && (conversa.auto_respostas_janela || 0) >= max;
}

async function responderComTrava(ctx, igsid, conversaTravada, estado) {
  const { banco } = ctx;
  let conversa = conversaTravada;

  for (let volta = 0; volta < MAX_VOLTAS; volta++) {
    if (volta > 0) conversa = await banco.conversa(igsid);
    if (!conversa || conversa.humano || conversa.pausada_manual) return;

    const msgs = await banco.mensagensRecentes(igsid, HISTORICO);
    const turno = turnoPendente(msgs, estado);
    if (!turno.length) return;
    const midsTurno = new Set(turno.map((m) => m.mid));
    const midEntrada = turno.at(-1).mid;
    const cobrir = () => midsTurno.forEach((mid) => estado.cobertas.add(mid));
    const agora = ctx.now();
    const base = { igsid, mid_entrada: midEntrada };

    // janela de 24h, pela última entrada do cliente gravada no banco
    const ultimaEntrada = Math.max(...msgs.filter((m) => m.direcao === "entrada").map((m) => Date.parse(m.enviada_em)));
    if (!janelaAberta(ultimaEntrada, agora)) {
      cobrir();
      await registrar(ctx, { ...base, tipo: "bloqueio", motivo: "fora_da_janela", detalhe: "última mensagem do cliente tem 24h ou mais" });
      return;
    }

    const max = maxPorJanela(ctx.env);
    if (limiteAtingido(conversa, max, agora)) {
      cobrir();
      await passarParaHumano(ctx, { ...base, motivo: "limite_respostas", detalhe: `${conversa.auto_respostas_janela} respostas automáticas em 24h (máximo ${max})` });
      return;
    }

    const textoTurno = montarTurno(turno);
    const pre = preChecagem(textoTurno);
    if (pre) {
      cobrir();
      await passarParaHumano(ctx, { ...base, ...pre });
      return;
    }

    if (volta > 0 && agora - ctx.inicio > ORCAMENTO_LLM_MS) {
      cobrir();
      await registrar(ctx, { ...base, tipo: "bloqueio", motivo: "sem_tempo", detalhe: "sem tempo pra outra chamada ao LLM nesta execução" });
      return;
    }

    // ── LLM ──
    const historico = msgs.filter((m) => !midsTurno.has(m.mid)).map(paraLlm);
    let r;
    try {
      r = await chamarModelo(
        [
          { role: "system", content: `${ctx.lerManual()}\n\n---\n\n${blocoContexto(new Date(agora))}` },
          ...historico,
          { role: "user", content: textoTurno || "[mensagem sem texto]" },
        ],
        { env: ctx.env, fetch: ctx.fetch }
      );
    } catch (err) {
      cobrir();
      const detalhe = sanitizar(err?.message || err, ctx.segredos).slice(0, 500);
      console.error(`[${ctx.conta.slug}] dm ${midEntrada}: LLM falhou: ${detalhe}`);
      await registrar(ctx, { ...base, tipo: "bloqueio", motivo: "erro_llm", detalhe, modelo: modeloAgente(ctx.env) });
      return;
    }
    const llm = { modelo: r.modelo, custo_usd: r.custoUsd };

    const lida = lerRespostaModelo(r.conteudo);
    if (!lida.ok) {
      cobrir();
      await passarParaHumano(ctx, { ...base, ...llm, motivo: "llm_invalido", detalhe: lida.erro, texto: String(r.conteudo ?? "").slice(0, 1000) });
      return;
    }
    const extra = { ...base, ...llm, confianca: lida.confianca, texto: lida.texto || null };
    if (lida.acao === "humano") {
      cobrir();
      await passarParaHumano(ctx, { ...extra, motivo: `modelo:${lida.motivo || "OUTRO"}`, detalhe: "o modelo pediu humano" });
      return;
    }
    const minimo = confiancaMinima(ctx.env);
    if (lida.confianca < minimo) {
      cobrir();
      await passarParaHumano(ctx, { ...extra, motivo: "confianca_baixa", detalhe: `confiança ${lida.confianca} < ${minimo}` });
      return;
    }
    const trava = travasDoTexto(lida.texto, ctx.now());
    if (trava) {
      cobrir();
      await passarParaHumano(ctx, { ...extra, ...trava });
      return;
    }

    // ── Reconfere antes de enviar ──
    // O Vinicius pode ter respondido (eco) ou o cliente mandado mais coisa
    // enquanto o LLM pensava.
    const [atual, msgsAtuais] = await Promise.all([banco.conversa(igsid), banco.mensagensRecentes(igsid, HISTORICO)]);
    if (!atual || atual.humano || atual.pausada_manual) {
      cobrir();
      await registrar(ctx, { ...extra, tipo: "bloqueio", motivo: "pausada_durante", detalhe: "a conversa foi pausada ou passou pra humano enquanto o LLM respondia" });
      return;
    }
    const novas = msgsAtuais.filter((m) => m.direcao === "entrada" && !midsTurno.has(m.mid) && !estado.cobertas.has(m.mid));
    if (novas.length) {
      // refaz com o turno maior (estas entradas ainda não estão cobertas)
      console.log(`[${ctx.conta.slug}] dm ${igsid}: chegou mensagem nova durante o LLM — refazendo`);
      continue;
    }

    // ── Envio ──
    const enviadoEm = new Date(ctx.now()).toISOString();
    // marca ANTES do POST: o eco pode chegar antes de gravarmos o mid
    await banco.atualizarConversa(igsid, { ultima_auto_texto: lida.texto, ultima_auto_em: enviadoEm });
    const envio = await enviarDm(ctx, igsid, lida.texto);
    cobrir();
    if (!envio.ok) {
      console.error(`[${ctx.conta.slug}] dm ${midEntrada}: envio falhou: ${envio.erro}`);
      await registrar(ctx, { ...extra, tipo: "erro_envio", motivo: "envio_falhou", detalhe: envio.erro });
      return;
    }
    await banco.gravarMensagem({
      mid: envio.mid, igsid, texto: lida.texto, tipo: "texto",
      direcao: "saida_auto", origem: "llm", enviada_em: enviadoEm,
    });
    const inicioJanela = conversa.janela_inicio_em ? Date.parse(conversa.janela_inicio_em) : NaN;
    const mesmaJanela = Number.isFinite(inicioJanela) && ctx.now() - inicioJanela < JANELA_24H_MS;
    await banco.atualizarConversa(igsid, {
      ...(mesmaJanela
        ? { auto_respostas_janela: (conversa.auto_respostas_janela || 0) + 1 }
        : { auto_respostas_janela: 1, janela_inicio_em: enviadoEm }),
      ultima_saida_em: enviadoEm,
      atualizado_em: enviadoEm,
    });
    console.log(`[${ctx.conta.slug}] dm ${midEntrada}: respondida (${Buffer.byteLength(lida.texto, "utf8")} bytes, US$ ${llm.custo_usd})`);
    await registrar(ctx, { ...extra, tipo: "resposta", mid_saida: envio.mid, motivo: lida.motivo || null });
  }
}

async function passarParaHumano(ctx, { motivo, detalhe, ...resto }) {
  const agoraIso = new Date(ctx.now()).toISOString();
  await ctx.banco.atualizarConversa(resto.igsid, { humano: true, humano_motivo: motivo, humano_em: agoraIso, atualizado_em: agoraIso });
  console.log(`[${ctx.conta.slug}] dm ${resto.igsid}: passou pra humano (${motivo})`);
  await registrar(ctx, { ...resto, tipo: "humano", motivo, detalhe });
}

// POST /me/messages com recipient.id = IGSID. Devolve { ok, mid } ou { ok:false, erro } sanitizado.
async function enviarDm(ctx, igsid, texto) {
  try {
    const r = await ctx.fetch(`${GRAPH}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}` },
      body: JSON.stringify({ recipient: { id: igsid }, message: { text: texto } }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, erro: sanitizar(`Graph ${r.status}: ${JSON.stringify(data).slice(0, 300)}`, ctx.segredos) };
    }
    // sem message_id (não deveria acontecer): grava com um mid local; o eco
    // é reconhecido pelo texto
    return { ok: true, mid: data.message_id ? String(data.message_id) : `local:${randomUUID()}` };
  } catch (err) {
    return { ok: false, erro: sanitizar(`Graph: ${err?.message || err}`, ctx.segredos) };
  }
}

// Log nunca derruba nada.
async function registrar(ctx, linha) {
  const l = { ...linha };
  if (l.detalhe != null) l.detalhe = sanitizar(l.detalhe, ctx.segredos).slice(0, 1000);
  try {
    await ctx.banco.registrarLog({ ...l, criado_em: new Date(ctx.now()).toISOString() });
  } catch (err) {
    console.error(`[${ctx.conta.slug}] dm: falhou gravar log (${l.tipo}): ${sanitizar(err?.message || err, ctx.segredos)}`);
  }
}
