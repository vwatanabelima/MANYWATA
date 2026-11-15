// CLI pra publicar um carrossel aprovado. Fala com POST /api/midia/publicar
// do MANYWATA (não com o Instagram direto).
//
// Uso:
//   node scripts/midia.mjs publicar <pasta-render> --base-url <url-https-pública> --confirmar [--conta eterniza] [--dry-run]
//
// Só rode com o ok do Vinicius nas imagens e no texto: a chamada publica
// direto, não tem rascunho. Sem --confirmar o CLI recusa.
//
// A pasta de render tem slide-01.jpg, slide-02.jpg, ... (ordem numérica,
// slide-2 antes de slide-10) e instagram-post.txt com a legenda.
//
// --base-url: quem baixa as imagens é o servidor do Meta, então os mesmos
// JPEGs da pasta precisam já estar numa URL https pública. Os nomes dos
// arquivos são anexados nela (base/slide-01.jpg, ...). Este CLI não faz
// upload.
//
// --dry-run: mostra o que mandaria e não chama nada.
//
// Lê PUBLICAR_SECRET e MANYWATA_URL do ambiente ou do .env.local. Nunca
// imprime o segredo.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL_PADRAO = "https://manywata.vercel.app";
const ROTA = "/api/midia/publicar";
const USO =
  "Uso: node scripts/midia.mjs publicar <pasta-render> --base-url <url-https-pública> --confirmar [--conta eterniza] [--dry-run]";

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
// sai com 1. Injeção (fetch, lerVar, log) é pros testes.
export async function executar(argv, { fetch = globalThis.fetch, lerVar = lerVarPadrao, log = console.log } = {}) {
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

  const baseUrl = opt("--base-url");
  if (!baseUrl) {
    throw new Error(
      [
        "Falta --base-url.",
        "O Instagram baixa as imagens de uma URL https pública; este CLI não faz upload.",
        "Deixe estes JPEGs numa pasta pública e passe a URL dela em --base-url:",
        ...slides.map((s) => `  ${s}`),
      ].join("\n")
    );
  }
  const itens = montarUrls(baseUrl, slides);

  const arquivoLegenda = join(pasta, "instagram-post.txt");
  let legenda;
  try {
    legenda = readFileSync(arquivoLegenda, "utf8");
  } catch {
    throw new Error(`Não achei a legenda em ${arquivoLegenda}.`);
  }

  const corpo = {
    conta: opt("--conta") || "eterniza",
    tipo: "CAROUSEL",
    itens: itens.map((url) => ({ url })),
    legenda,
    confirmar: true,
  };
  const base = (lerVar("MANYWATA_URL") || URL_PADRAO).replace(/\/$/, "");

  if (tem("--dry-run")) {
    log(`[dry-run] POST ${base}${ROTA}  (nada foi enviado)`);
    log(JSON.stringify(corpo, null, 2));
    return null;
  }

  const segredo = lerVar("PUBLICAR_SECRET");
  if (!segredo) throw new Error("PUBLICAR_SECRET não achado no ambiente nem no .env.local.");

  log(`Publicando carrossel (${itens.length} slides) em "${corpo.conta}"... pode levar até ~1 min.`);
  let r;
  try {
    r = await fetch(`${base}${ROTA}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${segredo}`, "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
  } catch (e) {
    throw new Error(
      `Falha de rede chamando ${base}${ROTA}: ${e.message}\nPode ter publicado mesmo assim: confira o perfil ANTES de rodar de novo.`
    );
  }
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    const extra = dados.erro ? "" : "\nResposta sem detalhe (timeout da Vercel?): confira o perfil ANTES de rodar de novo.";
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
