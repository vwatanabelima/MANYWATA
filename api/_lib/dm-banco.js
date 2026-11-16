// Acesso ao Supabase (PostgREST) pras DMs, com fetch nativo e a service role.
//
// Tabelas no schema public com prefixo ig_dm_ (o PostgREST do Supabase só
// expõe public por padrão). RLS ligada sem policy: anon/authenticated não
// leem nada, só a service role (que passa por cima de RLS). Migração em
// supabase/migrations/*_ig_dm.sql.
//
// Envs: DM_SUPABASE_URL e DM_SUPABASE_SERVICE_ROLE_KEY. Nomes próprios de
// propósito: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY deste repo são só do
// terminal do operador (CLI de mídia) e não vão pra Vercel.
//
// Todo erro passa por sanitizar() com a chave: nem a service role nem token
// nenhum aparecem em log.

import { sanitizar } from "./seguranca.js";

const TIMEOUT_MS = 8_000;

// null quando falta env (o webhook só avisa e segue).
export function lerCredenciaisBanco(env = process.env) {
  const url = String(env.DM_SUPABASE_URL ?? "").trim();
  const chave = String(env.DM_SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!url || !chave) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  return { url: u.origin, chave };
}

export function criarBanco({ url, chave }, fetchFn = globalThis.fetch) {
  async function chamar(metodo, tabela, params = {}, corpo, prefer) {
    const qs = new URLSearchParams(params).toString();
    const headers = {
      apikey: chave,
      Authorization: `Bearer ${chave}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (prefer) headers.Prefer = prefer;
    let r;
    try {
      r = await fetchFn(`${url}/rest/v1/${tabela}${qs ? `?${qs}` : ""}`, {
        method: metodo,
        headers,
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(sanitizar(`supabase ${metodo} ${tabela}: ${e?.message || e}`, [chave]));
    }
    const texto = await r.text().catch(() => "");
    if (!r.ok) throw new Error(sanitizar(`supabase ${metodo} ${tabela} ${r.status}: ${texto.slice(0, 300)}`, [chave]));
    if (!texto) return [];
    try {
      return JSON.parse(texto);
    } catch {
      return [];
    }
  }

  return {
    // Cria ou atualiza a conversa (só as colunas passadas mudam) e devolve a linha.
    async salvarConversa(campos) {
      const linhas = await chamar(
        "POST", "ig_dm_conversas", { on_conflict: "igsid" }, [campos],
        "resolution=merge-duplicates,return=representation"
      );
      return linhas[0] || null;
    },

    async conversa(igsid) {
      const linhas = await chamar("GET", "ig_dm_conversas", { select: "*", igsid: `eq.${igsid}`, limit: "1" });
      return linhas[0] || null;
    },

    // PATCH com filtros extras (trava condicional). Devolve as linhas que mudaram.
    async atualizarConversa(igsid, campos, filtros = {}) {
      return chamar("PATCH", "ig_dm_conversas", { igsid: `eq.${igsid}`, ...filtros }, campos, "return=representation");
    },

    // Grava a mensagem. false = o mid já existia (reentrega do webhook).
    async gravarMensagem(msg) {
      const linhas = await chamar(
        "POST", "ig_dm_mensagens", { on_conflict: "mid" }, [msg],
        "resolution=ignore-duplicates,return=representation"
      );
      return linhas.length > 0;
    },

    async mensagemPorMid(mid) {
      const linhas = await chamar("GET", "ig_dm_mensagens", { select: "mid,direcao", mid: `eq.${mid}`, limit: "1" });
      return linhas[0] || null;
    },

    // Últimas N mensagens da conversa, da mais antiga pra mais nova.
    async mensagensRecentes(igsid, limite = 30) {
      const linhas = await chamar("GET", "ig_dm_mensagens", {
        select: "mid,direcao,origem,tipo,texto,enviada_em,criado_em",
        igsid: `eq.${igsid}`,
        order: "criado_em.desc,id.desc",
        limit: String(limite),
      });
      return linhas.reverse();
    },

    async registrarLog(linha) {
      await chamar("POST", "ig_dm_log", {}, [linha], "return=minimal");
    },
  };
}
