// CLI pra publicar um carrossel aprovado. Fala com POST /api/midia/publicar
// do MANYWATA (não com o Instagram direto).
//
// Uso:
//   node scripts/midia.mjs publicar <pasta-render> --confirmar [--conta eterniza] [--base-url <url>] [--dry-run]
//
// Só rode com o ok do Vinicius nas imagens e no texto: a chamada publica
// direto, não tem rascunho. Sem --confirmar o CLI recusa.
//
// A pasta de render tem slide-01.jpg, slide-02.jpg, ... (ordem numérica,
// slide-2 antes de slide-10) e instagram-post.txt com a legenda.
//
// Quem baixa as imagens é o servidor do Meta, então elas precisam estar numa
// URL https pública:
//   - sem --base-url (padrão): sobe os JPEGs pro Supabase Storage (bucket
//     público instagram-temp do eternizacards), publica e apaga. Precisa de
//     SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente (nunca do
//     .env.local): set -a; . /home/box/.secrets/supabase-eterniza.env; set +a
//   - com --base-url: os JPEGs já estão nessa URL (base/slide-01.jpg, ...);
//     não sobe nem apaga nada.
//
// --dry-run: mostra o que mandaria (e os caminhos no Storage) e não chama nada.
//
// Lê PUBLICAR_SECRET e MANYWATA_URL do ambiente ou do .env.local. Nunca
// imprime segredo nem chave.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sanitizar } from "../api/_lib/seguranca.js";
import {
  BUCKET,
  apagarDoStorage,
  carimbo,
  enviarParaStorage,
  lerCredenciaisStorage,
  lerSlidesJpeg,
  montarCaminhos,
  slugDaPasta,
  urlPublica,
} from "./_storage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL_PADRAO = "https://manywata.vercel.app";
const ROTA = "/api/midia/publicar";
const USO =
  "Uso: node scripts/midia.mjs publicar <pasta-render> --confirmar [--conta eterniza] [--base-url <url-https-pública>] [--dry-run]";
const CONFERIR = "confira o perfil ANTES de rodar de novo.";

// ── Partes puras ──────────────────────────────────────────────────────────

// slide-NN.jpg em ordem numérica (slide-2 antes de slide-10).
export function listarSlides(pasta) {
  return readdirSync(pasta)
    .map((nome) => ({ nome, m: /^slide-(\d+)\.jpe?g$/i.exec(nome) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map((x) => x.nome);
}

export function montarUrls(baseUrl, arquivos) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error(`--base-url inválida: ${baseUrl}`);
  }
  if (base.protocol !== "https:") throw new Error("--base-url precisa ser https (o Meta baixa de fora).");
  const prefixo = base.href.endsWith("/") ? base.href : `${base.href}/`;
  return arquivos.map((nome) => new URL(encodeURIComponent(nome), prefixo).href);
}

// ── Config ────────────────────────────────────────────────────────────────

let envLocal = null;
function lerVarPadrao(nome) {
  if (process.env[nome]) return process.env[nome].trim();
  if (envLocal === null) {
    try {
      envLocal = readFileSync(join(ROOT, ".env.local"), "utf8");
    } catch {
      envLocal = "";
    }
  }
  const linha = envLocal.split("\n").find((l) => l.startsWith(`${nome}=`));
  return linha ? linha.slice(nome.length + 1).trim().replace(/^["']|["']$/g, "") : undefined;
}

// ── Comando ───────────────────────────────────────────────────────────────

// Lança Error com a mensagem pro usuário; o bootstrap lá embaixo imprime e
// sai com 1. Injeção (fetch, lerVar, env, log, avisar, agora, sufixo) é pros
// testes. SUPABASE_* vêm só de `env` (process.env), nunca do .env.local.
export async function executar(
  argv,
  {
    fetch = globalThis.fetch,
    lerVar = lerVarPadrao,
    env = process.env,
    log = console.log,
    avisar = console.warn,
    agora = () => new Date(),
    sufixo,
  } = {}
) {
  const [comando, ...resto] = argv;
  const opt = (flag) => {
    const i = resto.indexOf(flag);
    return i >= 0 && resto[i + 1] && !resto[i + 1].startsWith("--") ? resto[i + 1] : undefined;
  };
  const tem = (flag) => resto.includes(flag);

  if (comando !== "publicar") throw new Error(USO);
  if (!tem("--confirmar")) {
    throw new Error("Recusado: publicar exige --confirmar. Só rode com o ok do Vinicius nas imagens e no texto.");
  }

  const pasta = resto[0] && !resto[0].startsWith("--") ? resto[0] : undefined;
  if (!pasta) throw new Error(`Falta a pasta de render.\n${USO}`);
  let slides;
  try {
    slides = listarSlides(pasta);
  } catch {
    throw new Error(`Não consegui ler a pasta ${pasta}.`);
  }
  if (!slides.length) throw new Error(`Nenhum slide-NN.jpg em ${pasta}.`);

  // Legenda antes de qualquer upload.
  const arquivoLegenda = join(pasta, "instagram-post.txt");
  let legenda;
  try {
    legenda = readFileSync(arquivoLegenda, "utf8");
  } catch {
    throw new Error(`Não achei a legenda em ${arquivoLegenda}.`);
  }

  const conta = opt("--conta") || "eterniza";
  const corpo = (urls) => ({ conta, tipo: "CAROUSEL", itens: urls.map((url) => ({ url })), legenda, confirmar: true });
  const base = (lerVar("MANYWATA_URL") || URL_PADRAO).replace(/\/$/, "");
  const dryRun = tem("--dry-run");
  const mostrarDryRun = (c) => {
    log(`[dry-run] POST ${base}${ROTA}  (nada foi enviado)`);
    log(JSON.stringify(c, null, 2));
  };

  // ── Com --base-url: as imagens já estão públicas, nada de Storage ──
  const baseUrl = opt("--base-url");
  if (baseUrl) {
    const c = corpo(montarUrls(baseUrl, slides));
    if (dryRun) {
      mostrarDryRun(c);
      return null;
    }
    return chamarRota({ fetch, base, segredo: exigirSegredo(lerVar), corpo: c, log });
  }

  // ── Sem --base-url: sobe pro Supabase Storage, publica, apaga ──
  // Tudo que pode recusar sem rede vem antes do primeiro upload. Dry-run não
  // exige credencial (só avisa lá embaixo).
  const cred = dryRun ? null : lerCredenciaisStorage(env);
  const segredo = dryRun ? null : exigirSegredo(lerVar);
  if (slides.length < 2 || slides.length > 10) {
    throw new Error(`Carrossel precisa de 2 a 10 slides; achei ${slides.length} em ${pasta}. Nada foi enviado.`);
  }
  const arquivos = lerSlidesJpeg(pasta, slides);
  const prefixo = `${slugDaPasta(pasta)}-${carimbo(agora(), sufixo)}`;
  const caminhos = montarCaminhos(prefixo, slides);

  if (dryRun) {
    let credDry = null;
    try {
      credDry = lerCredenciaisStorage(env);
    } catch {
      // só avisa
    }
    log(`[dry-run] subiria ${caminhos.length} JPEG(s) pro Supabase Storage (nada foi enviado):`);
    for (const c of caminhos) log(`  ${BUCKET}/${c}`);
    if (!credDry) {
      log("  aviso: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes ou inválidas no ambiente; o publicar de verdade vai recusar.");
    }
    mostrarDryRun(corpo(caminhos.map((c) => urlPublica(credDry?.url ?? "<SUPABASE_URL>", c))));
    log(`[dry-run] depois de publicar, apagaria ${BUCKET}/${prefixo}/`);
    return null;
  }

  const limpo = (texto) => sanitizar(texto, [cred.chave, segredo]);

  let enviados = [];
  try {
    log(`Subindo ${arquivos.length} JPEG(s) para ${BUCKET}/${prefixo}/ ...`);
    let urls;
    try {
      ({ caminhos: enviados, urls } = await enviarParaStorage({ arquivos, prefixo, cred, fetch }));
    } catch (e) {
      enviados = e.caminhos ?? [];
      throw new Error(`${e.message}\nNada foi publicado.`);
    }
    return await chamarRota({ fetch, base, segredo, corpo: corpo(urls), log });
  } catch (e) {
    throw new Error(limpo(e?.message));
  } finally {
    // Sempre apaga, inclusive quando o resultado da publicação é incerto: o
    // Meta baixa as imagens ao criar os containers. Se apagar no meio de uma
    // publicação ainda em andamento, o pior caso é o container dar ERROR e
    // nada ir pro ar (as mensagens de erro incerto já mandam conferir o perfil).
    if (enviados.length) {
      try {
        await apagarDoStorage({ caminhos: enviados, cred, fetch });
        log(`Temporários apagados de ${BUCKET}/${prefixo}/.`);
      } catch (e) {
        avisar(
          limpo(
            [
              `aviso: não consegui apagar os temporários do Storage (${e?.message}).`,
              "Apague à mão no painel do Supabase (Storage → instagram-temp):",
              ...enviados.map((c) => `  ${BUCKET}/${c}`),
            ].join("\n")
          )
        );
      }
    }
  }
}

function exigirSegredo(lerVar) {
  const segredo = lerVar("PUBLICAR_SECRET");
  if (!segredo) throw new Error("PUBLICAR_SECRET não achado no ambiente nem no .env.local.");
  return segredo;
}

async function chamarRota({ fetch, base, segredo, corpo, log }) {
  log(`Publicando carrossel (${corpo.itens.length} slides) em "${corpo.conta}"... pode levar até ~1 min.`);
  let r;
  try {
    r = await fetch(`${base}${ROTA}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${segredo}`, "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
  } catch (e) {
    throw new Error(`Falha de rede chamando ${base}${ROTA}: ${e.message}\nPode ter publicado mesmo assim: ${CONFERIR}`);
  }
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    const extra = dados.erro ? "" : `\nResposta sem detalhe (timeout da Vercel?): pode ter publicado, ${CONFERIR}`;
    throw new Error(`HTTP ${r.status}: ${dados.erro || "sem detalhe"}${extra}`);
  }

  log(`Publicado em @${dados.username}: ${dados.permalink || "(permalink indisponível)"}`);
  log(`  media_id: ${dados.mediaId}  ·  cota 24h: ${dados.quota?.usado}/${dados.quota?.total}`);
  if (dados.aviso) log(`  aviso: ${dados.aviso}`);
  return dados;
}

// Só roda como CLI; importado (testes) só expõe as funções.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await executar(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
