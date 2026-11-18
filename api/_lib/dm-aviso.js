// Aviso ao Vinicius quando uma DM passa pra humano.
//
// O registro que SEMPRE existe é o banco: ig_dm_conversas.humano + a view
// public.ig_dm_pendentes_humano (migração). Isto aqui é o empurrão opcional,
// por canais. Hoje só tem Telegram, no mesmo padrão do painel
// (eternizacards-painel, lib/agente/zap/saida.ts, avisar()): mesmas envs
// TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID, sendMessage com texto até 4000 e
// disable_web_page_preview. Canal sem env fica desligado, calado.
//
// Nunca lança: falha de canal vira console.error sanitizado (sem o token do
// bot, que vai na URL do Telegram).
//
// Pra outro canal (ex.: e-mail via Resend), basta mais um item em CANAIS com
// ativo(env) e enviar(texto, ctx). Ver README, seção DMs.

import { sanitizar } from "./seguranca.js";

const TELEGRAM_API = "https://api.telegram.org";
const TELEGRAM_MAX = 4000;
const TIMEOUT_MS = 5_000;
const TRECHO_CLIENTE = 300;
const TRECHO_DETALHE = 300;

// Chat do Telegram como o painel lê: tira aspas, Number (grupo é negativo).
export function chatTelegram(env = process.env) {
  const n = Number(String(env.TELEGRAM_CHAT_ID ?? "").trim().replace(/^["']|["']$/g, ""));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

const tokenTelegram = (env = process.env) => String(env.TELEGRAM_BOT_TOKEN ?? "").trim();

// Tira o token do bot de qualquer texto (a URL do Telegram leva o token).
export function sanitizarTelegram(texto, env = process.env) {
  return sanitizar(texto, [tokenTelegram(env)]).replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[oculto]");
}

export const CANAIS = [
  {
    nome: "telegram",
    ativo: (env) => !!tokenTelegram(env) && chatTelegram(env) != null,
    async enviar(texto, { env, fetch }) {
      const r = await fetch(`${TELEGRAM_API}/bot${tokenTelegram(env)}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatTelegram(env), text: texto.slice(0, TELEGRAM_MAX), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r.ok) {
        const corpo = await r.text().catch(() => "");
        throw new Error(`Telegram ${r.status}: ${corpo.slice(0, 300)}`);
      }
    },
  },
];

const corta = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Texto do aviso. Sem token nenhum: só motivo, detalhe curto, igsid e um
// trecho do que o cliente escreveu.
export function textoAviso({ igsid, motivo, detalhe, ultimoTexto }) {
  const linhas = [
    "🙋 DM do Instagram (@eternizacards) passou pra humano",
    `Motivo: ${motivo || "?"}`,
  ];
  if (detalhe) linhas.push(`Detalhe: ${corta(detalhe, TRECHO_DETALHE)}`);
  linhas.push(`IGSID: ${igsid}`);
  if (ultimoTexto) linhas.push(`Cliente: "${corta(ultimoTexto, TRECHO_CLIENTE)}"`);
  linhas.push("", "Responda pelo direct do @eternizacards no app. Fila: view ig_dm_pendentes_humano no Supabase.");
  return linhas.join("\n");
}

// avisarHumano({igsid, motivo, detalhe, ultimoTexto}). Devolve o resultado
// por canal ({ telegram: "ok" | "erro" }; canal desligado não aparece).
export async function avisarHumano(dados, { env = process.env, fetch: fetchFn = globalThis.fetch, rotulo = "eterniza" } = {}) {
  const resultado = {};
  try {
    const ativos = CANAIS.filter((c) => c.ativo(env));
    console.log(`[${rotulo}] dm ${dados.igsid}: aviso de humano (${dados.motivo}) — canais: ${ativos.map((c) => c.nome).join(", ") || "nenhum (só banco)"}`);
    if (!ativos.length) return resultado;
    const texto = textoAviso(dados);
    await Promise.all(
      ativos.map(async (c) => {
        try {
          await c.enviar(texto, { env, fetch: fetchFn });
          resultado[c.nome] = "ok";
        } catch (err) {
          resultado[c.nome] = "erro";
          console.error(`[${rotulo}] dm ${dados.igsid}: aviso por ${c.nome} falhou: ${sanitizarTelegram(err?.message || err, env)}`);
        }
      })
    );
  } catch (err) {
    console.error(`[${rotulo}] dm: aviso de humano falhou: ${sanitizarTelegram(err?.message || err, env)}`);
  }
  return resultado;
}
