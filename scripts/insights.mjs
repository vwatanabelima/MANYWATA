// Puxa insights orgânicos dos últimos posts das contas cadastradas em
// api/contas.js e imprime um relatório compacto + salva o JSON cru. Reusa o
// mesmo token do webhook (renovado pelo cron refresh-token.mjs), lido do
// .env.local ou do ambiente.
//
// Uso:
//   node scripts/insights.mjs                      # watanabe, últimos 12 posts
//   node scripts/insights.mjs --conta eterniza
//   node scripts/insights.mjs --conta all          # todas as contas
//   node scripts/insights.mjs --limit 20
//   node scripts/insights.mjs --no-save            # não grava JSON
//
// Se der 401: o cron rotacionou o token na Vercel. Recopie o token da conta
// (env var listado em contas.js) da Vercel pro .env.local.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTAS, contaPorSlug } from "../api/contas.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GRAPH = "https://graph.instagram.com/v21.0";

// --- args ---
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const LIMIT = Number(getArg("--limit", "12"));
const SAVE = !args.includes("--no-save");
const ALVO = getArg("--conta", "watanabe");

const contas =
  ALVO === "all"
    ? CONTAS
    : [contaPorSlug(ALVO)].filter(Boolean);

if (!contas.length) {
  const slugs = CONTAS.map((c) => c.slug).join(", ");
  console.error(`conta "${ALVO}" não existe em api/contas.js. Disponíveis: ${slugs}, all`);
  process.exit(1);
}

// --- token ---
// Procura primeiro no ambiente, depois no .env.local. O nome do env var vem
// da conta (tokenEnv), então cada conta tem o seu.
let envLocal = null;
function loadToken(conta) {
  const doAmbiente = process.env[conta.tokenEnv];
  if (doAmbiente) return doAmbiente.trim();

  if (envLocal === null) {
    try {
      envLocal = readFileSync(join(ROOT, ".env.local"), "utf8");
    } catch {
      envLocal = "";
    }
  }
  const prefixo = `${conta.tokenEnv}=`;
  const line = envLocal.split("\n").find((l) => l.startsWith(prefixo));
  if (!line) {
    throw new Error(`${conta.tokenEnv} não achado no ambiente nem no .env.local`);
  }
  return line.slice(prefixo.length).trim().replace(/^["']|["']$/g, "");
}

function apiPara(token) {
  return async function api(path, params = {}) {
    const qs = new URLSearchParams({ ...params, access_token: token }).toString();
    const res = await fetch(`${GRAPH}/${path}?${qs}`);
    const json = await res.json();
    if (!res.ok) {
      const msg = json?.error?.message || JSON.stringify(json);
      throw new Error(`API ${path} -> HTTP ${res.status}: ${msg}`);
    }
    return json;
  };
}

// Métricas suportadas por tipo (evita erro de métrica inválida por produto).
const METRICS = {
  REELS: ["reach", "views", "saved", "shares", "likes", "comments", "total_interactions", "ig_reels_avg_watch_time"],
  FEED: ["reach", "views", "saved", "shares", "likes", "comments", "total_interactions", "profile_visits"],
  STORY: ["reach", "replies", "shares", "total_interactions"],
};

async function insightsFor(api, media) {
  const metrics = METRICS[media.media_product_type] || METRICS.FEED;
  try {
    const r = await api(`${media.id}/insights`, { metric: metrics.join(",") });
    const out = {};
    for (const m of r.data) out[m.name] = m.values?.[0]?.value ?? 0;
    return out;
  } catch (e) {
    return { _erro: e.message };
  }
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const num = (s, n) => String(s ?? "-").padStart(n);

async function rodar(conta) {
  const api = apiPara(loadToken(conta));

  const me = await api("me", { fields: "username,account_type" });
  const mediaRes = await api("me/media", {
    fields: "id,media_type,media_product_type,caption,timestamp,permalink",
    limit: String(LIMIT),
  });

  const rows = [];
  for (const m of mediaRes.data) {
    const ins = await insightsFor(api, m);
    const reach = ins.reach || 0;
    rows.push({
      data: m.timestamp.slice(0, 10),
      tipo: m.media_product_type,
      reach,
      views: ins.views ?? null,
      saves: ins.saved ?? 0,
      shares: ins.shares ?? 0,
      likes: ins.likes ?? 0,
      coments: ins.comments ?? 0,
      interacoes: ins.total_interactions ?? 0,
      // retenção reels: ms -> s
      retencao_s: ins.ig_reels_avg_watch_time != null ? +(ins.ig_reels_avg_watch_time / 1000).toFixed(1) : null,
      save_rate: reach ? +((ins.saved || 0) / reach * 100).toFixed(1) : 0,
      eng_rate: reach ? +((ins.total_interactions || 0) / reach * 100).toFixed(1) : 0,
      legenda: (m.caption || "").replace(/\s+/g, " ").slice(0, 42),
      link: m.permalink,
      erro: ins._erro || null,
    });
  }

  // --- output compacto ---
  console.log(`\n@${me.username} (${me.account_type}) — últimos ${rows.length} posts\n`);
  console.log(
    pad("data", 11) + pad("tipo", 7) + num("reach", 7) + num("views", 7) +
    num("save", 5) + num("shr", 4) + num("like", 5) + num("com", 4) +
    num("ret_s", 6) + num("save%", 6) + num("eng%", 6) + "  legenda"
  );
  console.log("-".repeat(92));
  for (const r of rows) {
    console.log(
      pad(r.data, 11) + pad(r.tipo, 7) + num(r.reach, 7) + num(r.views, 7) +
      num(r.saves, 5) + num(r.shares, 4) + num(r.likes, 5) + num(r.coments, 4) +
      num(r.retencao_s, 6) + num(r.save_rate, 6) + num(r.eng_rate, 6) +
      "  " + r.legenda + (r.erro ? `  ⚠️ ${r.erro}` : "")
    );
  }

  // leitura rápida
  const reels = rows.filter((r) => r.tipo === "REELS");
  const feed = rows.filter((r) => r.tipo === "FEED");
  const avg = (arr, k) => arr.length ? +(arr.reduce((s, r) => s + (r[k] || 0), 0) / arr.length).toFixed(1) : 0;
  console.log("\nLeitura rápida:");
  console.log(`  Reels: ${reels.length} | reach médio ${avg(reels, "reach")} | save% médio ${avg(reels, "save_rate")} | retenção média ${avg(reels, "retencao_s")}s`);
  console.log(`  Feed:  ${feed.length} | reach médio ${avg(feed, "reach")} | save% médio ${avg(feed, "save_rate")}`);
  const totalSaves = rows.reduce((s, r) => s + r.saves, 0);
  console.log(`  Saves totais no período: ${totalSaves}${totalSaves === 0 ? "  ← regra Vera: CTA Salva não está convertendo" : ""}`);

  // --- salva JSON cru ---
  if (SAVE) {
    const day = new Date().toISOString().slice(0, 10);
    const dir = join(ROOT, "output");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `insights-${conta.slug}-${day}.json`);
    writeFileSync(file, JSON.stringify({ conta: me, gerado: new Date().toISOString(), posts: rows }, null, 2));
    console.log(`\nJSON salvo: ${file}`);
  }
}

// Uma conta com token vencido não pode derrubar o relatório das outras.
let falhou = false;
for (const conta of contas) {
  try {
    await rodar(conta);
  } catch (e) {
    falhou = true;
    console.error(`\n@${conta.username}: ${e.message}`);
  }
}
if (falhou) process.exit(1);
