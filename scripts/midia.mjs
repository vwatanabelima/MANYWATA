// CLI da especialista pra publicar mídia em duas etapas: rascunho → publicar.
// Fala com as rotas /api/midia/* do MANYWATA (não com o Instagram direto).
//
// Uso:
//   node scripts/midia.mjs rascunho <pasta-render> --base-url <url-publica> [--conta eterniza]
//   node scripts/midia.mjs rascunho --urls <url1,url2,...> --legenda <arquivo.txt> [--conta eterniza]
//   node scripts/midia.mjs publicar <id> --confirmar
//   node scripts/midia.mjs preview <id>
//
// Opções:
//   --conta <slug>       conta de api/contas.js (padrão: eterniza)
//   --tipo <TIPO>        padrão CAROUSEL (REELS/STORIES ainda dão 501)
//   --legenda <arquivo>  padrão: <pasta-render>/instagram-post.txt
//   --dry-run            mostra o que mandaria e não chama nada
//
// A pasta de render tem slide-01.jpg, slide-02.jpg, ... (ordem numérica,
// slide-2 antes de slide-10) e instagram-post.txt com a legenda.
//
// Por que --base-url é obrigatório: quem baixa as imagens é o servidor do
// Meta, então elas precisam estar numa URL https pública ANTES do rascunho.
// Este CLI ainda não faz upload (Vercel Blob pendente). Suba os JPEGs pra
// algum lugar público e passe a URL da pasta em --base-url (os nomes dos
// arquivos são anexados nela), ou passe a lista inteira em --urls.
//
// PONTO DE EXTENSÃO (Vercel Blob): quando existir BLOB_READ_WRITE_TOKEN, o
// upload entra em montarItens(): put() de cada slide no Blob e usa a URL
// devolvida. As rotas não mudam, continuam recebendo URL pública.
//
// Lê PUBLICAR_SECRET e MANYWATA_URL do ambiente ou do .env.local. Nunca
// imprime o segredo.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL_PADRAO = "https://manywata.vercel.app";

// ── Partes puras (testadas em tests/midia.test.js) ────────────────────────

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
function lerVar(nome) {
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

function sair(msg) {
  console.error(msg);
  process.exit(1);
}

// ── Comandos ──────────────────────────────────────────────────────────────

function montarItens({ pasta, baseUrl, urls }) {
  if (urls) return urls.split(",").map((u) => u.trim()).filter(Boolean);
  if (!pasta) sair("Falta a pasta de render (ou --urls).");
  const slides = listarSlides(pasta);
  if (!slides.length) sair(`Nenhum slide-NN.jpg em ${pasta}.`);
  if (!baseUrl) {
    sair(
      [
        "Falta --base-url.",
        "O Instagram baixa as imagens de uma URL https pública; este CLI ainda não faz upload",
        "(Vercel Blob está pendente). Suba os JPEGs abaixo pra uma pasta pública e rode de novo com",
        "--base-url <url-da-pasta>, ou passe --urls <url1,url2,...>:",
        ...slides.map((s) => `  ${s}`),
      ].join("\n")
    );
  }
  return montarUrls(baseUrl, slides);
}

function lerLegenda({ pasta, arquivoLegenda }) {
  const caminho = arquivoLegenda || (pasta && join(pasta, "instagram-post.txt"));
  if (!caminho) sair("Falta a legenda: passe --legenda <arquivo.txt>.");
  try {
    return readFileSync(caminho, "utf8");
  } catch {
    return sair(`Não achei a legenda em ${caminho} (use --legenda <arquivo.txt>).`);
  }
}

async function chamar(rota, corpo, { dryRun }) {
  const base = (lerVar("MANYWATA_URL") || URL_PADRAO).replace(/\/$/, "");
  if (dryRun) {
    console.log(`[dry-run] POST ${base}${rota}`);
    console.log(JSON.stringify(corpo, null, 2));
    return null;
  }
  const segredo = lerVar("PUBLICAR_SECRET");
  if (!segredo) sair("PUBLICAR_SECRET não achado no ambiente nem no .env.local.");

  let r;
  try {
    r = await fetch(`${base}${rota}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${segredo}`, "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
  } catch (e) {
    sair(`Falha de rede chamando ${base}${rota}: ${e.message}`);
  }
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) sair(`HTTP ${r.status}: ${dados.erro || "sem detalhe"}`);
  return dados;
}

async function rascunho(args, opt) {
  const pasta = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  const itens = montarItens({ pasta, baseUrl: opt("--base-url"), urls: opt("--urls") });
  const legenda = lerLegenda({ pasta, arquivoLegenda: opt("--legenda") });
  const corpo = {
    conta: opt("--conta") || "eterniza",
    tipo: (opt("--tipo") || "CAROUSEL").toUpperCase(),
    itens: itens.map((url) => ({ url })),
    legenda,
  };
  console.log(`Criando rascunho ${corpo.tipo} (${itens.length} itens) para "${corpo.conta}"... pode levar até ~1 min.`);
  const r = await chamar("/api/midia/rascunho", corpo, { dryRun: opt.flag("--dry-run") });
  if (!r) return;
  console.log("\nRascunho pronto. NADA foi publicado.");
  console.log(`  id:      ${r.id}`);
  console.log(`  preview: ${r.preview}`);
  console.log(`  expira:  ${r.expiraEm}`);
  console.log("\nMande o preview pro Vinicius. Só depois do OK:");
  console.log(`  node scripts/midia.mjs publicar ${r.id} --confirmar`);
}

async function publicar(args, opt) {
  const id = args[0];
  if (!id || id.startsWith("--")) sair("Uso: node scripts/midia.mjs publicar <id> --confirmar");
  if (!opt.flag("--confirmar")) {
    sair("Recusado: publicar exige --confirmar. Só rode com o OK explícito do Vinicius.");
  }
  const r = await chamar("/api/midia/publicar", { id, confirmar: true }, { dryRun: opt.flag("--dry-run") });
  if (!r) return;
  console.log(`Publicado em @${r.username}: ${r.permalink || "(permalink indisponível)"}`);
  console.log(`  media_id: ${r.mediaId}  ·  cota 24h: ${r.quota.usado}/${r.quota.total}`);
  if (r.aviso) console.log(`  aviso: ${r.aviso}`);
}

function preview(args) {
  const id = args[0];
  if (!id) sair("Uso: node scripts/midia.mjs preview <id>");
  const base = (lerVar("MANYWATA_URL") || URL_PADRAO).replace(/\/$/, "");
  console.log(`${base}/api/midia/preview?id=${encodeURIComponent(id)}`);
}

async function main(argv) {
  const [comando, ...resto] = argv;
  const opt = (flag) => {
    const i = resto.indexOf(flag);
    return i >= 0 && resto[i + 1] && !resto[i + 1].startsWith("--") ? resto[i + 1] : undefined;
  };
  opt.flag = (flag) => resto.includes(flag);

  if (comando === "rascunho") return rascunho(resto, opt);
  if (comando === "publicar") return publicar(resto, opt);
  if (comando === "preview") return preview(resto);
  sair(
    [
      "Uso:",
      "  node scripts/midia.mjs rascunho <pasta-render> --base-url <url-publica> [--conta eterniza]",
      "  node scripts/midia.mjs rascunho --urls <url1,url2,...> --legenda <arquivo.txt>",
      "  node scripts/midia.mjs publicar <id> --confirmar",
      "  node scripts/midia.mjs preview <id>",
    ].join("\n")
  );
}

// Só roda como CLI; importado (testes) só expõe as funções puras.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
