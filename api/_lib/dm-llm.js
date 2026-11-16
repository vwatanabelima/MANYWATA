// Chamada ao LLM da resposta automática de DM. Mesmo provedor, modelo e
// parâmetros do agente do WhatsApp do eternizacards-painel
// (lib/agente/zap/llm.ts): OpenRouter, papel "agente", temperature 0.4,
// max_tokens 700, usage.include (a resposta traz usage.cost em USD, que vai
// pro ig_dm_log).
//
// Diferença: aqui não tem ferramenta (consultar_pedido, link_pedido...). O
// modelo responde um JSON {acao, texto, motivo, confianca} e o código decide.
//
// Envs: OPENROUTER_API_KEY e OPENROUTER_MODELO_AGENTE (opcional), mesmos nomes
// do painel. Teto de gasto: o limite de crédito da própria chave no OpenRouter.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sanitizar } from "./seguranca.js";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const MODELO_PADRAO = "deepseek/deepseek-v4.1-flash-1017";
const TIMEOUT_MS = 25_000;

export const modeloAgente = (env = process.env) => String(env.OPENROUTER_MODELO_AGENTE ?? "").trim() || MODELO_PADRAO;

// O manual é a fonte das regras (cópia de eternizacards-painel @ dc6e271).
// Lido do arquivo em runtime; vercel.json inclui o arquivo na função do webhook.
let manualEmCache = null;
export function lerManual() {
  if (manualEmCache != null) return manualEmCache;
  const candidatos = [
    fileURLToPath(new URL("../../docs/agente-whatsapp-manual.md", import.meta.url)),
    join(process.cwd(), "docs", "agente-whatsapp-manual.md"),
  ];
  for (const caminho of candidatos) {
    try {
      manualEmCache = readFileSync(caminho, "utf8");
      return manualEmCache;
    } catch {
      // tenta o próximo
    }
  }
  throw new Error("manual do atendimento não encontrado (docs/agente-whatsapp-manual.md)");
}

// mensagens: [{role, content}] no formato OpenAI. Devolve { conteudo, custoUsd, modelo }.
export async function chamarModelo(mensagens, { env = process.env, fetch: fetchFn = globalThis.fetch } = {}) {
  const chave = String(env.OPENROUTER_API_KEY ?? "").trim();
  if (!chave) throw new Error("OPENROUTER_API_KEY ausente");
  const modelo = modeloAgente(env);
  let r;
  try {
    r = await fetchFn(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${chave}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://manywata.vercel.app",
        "X-Title": "Agente DM Instagram EternizaCards",
      },
      body: JSON.stringify({
        model: modelo,
        messages: mensagens,
        response_format: { type: "json_object" },
        temperature: 0.4,
        max_tokens: 700,
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(sanitizar(`OpenRouter: ${e?.message || e}`, [chave]));
  }
  if (!r.ok) {
    const corpo = await r.text().catch(() => "");
    throw new Error(sanitizar(`OpenRouter ${r.status}: ${corpo.slice(0, 300)}`, [chave]));
  }
  const j = await r.json().catch(() => ({}));
  const custoUsd = Number(j?.usage?.cost ?? 0);
  return {
    conteudo: j?.choices?.[0]?.message?.content ?? "",
    custoUsd: Number.isFinite(custoUsd) ? custoUsd : 0,
    modelo: typeof j?.model === "string" && j.model ? j.model : modelo,
  };
}
