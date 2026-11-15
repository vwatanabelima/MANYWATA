// CLI pra publicar um carrossel ou um story aprovado. Fala com POST
// /api/midia/publicar do MANYWATA (não com o Instagram direto).
//
// Uso:
//   node scripts/midia.mjs publicar <pasta-render> --confirmar [--conta eterniza] [--base-url <url>] [--dry-run]
//   node scripts/midia.mjs story <arquivo.jpg> --confirmar [--conta eterniza] [--base-url <url>] [--dry-run]
//   node scripts/midia.mjs limpar <prefixo> --confirmar
//
// Só rode o publicar/story com o ok do Vinicius nas imagens e no texto: a
// chamada publica direto, não tem rascunho. Sem --confirmar o CLI recusa.
//
// A pasta de render tem slide-01.jpg, slide-02.jpg, ... (ordem numérica,
// slide-2 antes de slide-10) e instagram-post.txt com a legenda.
//
// story: 1 JPEG (FF D8 FF, até 8 MB), SEM legenda (Story não tem caption na
// API). Avisa, sem bloquear, se não for 1080x1920. Sobe pra
// instagram-temp/<slug-do-arquivo>-<carimbo>/<slug-do-arquivo>.jpg e segue
// a mesma regra de limpeza abaixo. Com --base-url a URL é
// <base-url>/<nome-do-arquivo>.
//
// Quem baixa as imagens é o servidor do Meta, então elas precisam estar numa
// URL https pública:
//   - sem --base-url (padrão): sobe os JPEGs pro Supabase Storage (bucket
//     público instagram-temp do eternizacards), publica e apaga QUANDO O
//     RESULTADO É DEFINIDO (ver "Limpeza" abaixo). Precisa de SUPABASE_URL e
//     SUPABASE_SERVICE_ROLE_KEY no ambiente (nunca do .env.local):
//       set -a; . /home/box/.secrets/supabase-eterniza.env; set +a
//   - com --base-url: os JPEGs já estão nessa URL (base/slide-01.jpg, ...);
//     não sobe nem apaga nada.
//
// Limpeza dos temporários:
//   - DEFINIDO → apaga: sucesso (200 com mediaId), upload que falhou antes de
//     chamar a rota, ou erro da rota com corpo JSON {erro, publicado: false}
//     e status diferente de 504.
//   - INDEFINIDO → NÃO apaga, imprime os caminhos e o que fazer: erro de
//     rede, timeout do CLI (abort), resposta sem JSON/sem detalhe (ex.: 504
//     da própria Vercel), erro sem `publicado: false` (ex.: media_publish
//     chamado e falhou) e QUALQUER 504, mesmo vindo da nossa rota com
//     publicado: false. Nesse último caso o media_publish nunca foi chamado,
//     mas o Instagram pode continuar baixando as imagens dos containers por
//     um tempo; a regra fica conservadora de propósito: na dúvida, manter
//     custa uns KB no bucket, apagar cedo demais pode deixar um retry ou
//     um container em processamento sem imagem. Depois de conferir o perfil:
//       node scripts/midia.mjs limpar <prefixo> --confirmar
//
// --dry-run: mostra o que mandaria (e os caminhos no Storage) e não chama nada.
//
// Lê PUBLICAR_SECRET e MANYWATA_URL do ambiente ou do .env.local. Nunca
// imprime segredo nem chave.

import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sanitizar } from "../api/_lib/seguranca.js";
import { CLI_TIMEOUT_ROTA_MS, MAX_DURATION_S } from "../api/_lib/tempos.js";
import {
  BUCKET,
  apagarDoStorage,
  carimbo,
  dimensoesJpeg,
  enviarParaStorage,
  lerCredenciaisStorage,
  lerSlidesJpeg,
  listarDoStorage,
  montarCaminhos,
  normalizarPrefixo,
  sanitizarSlug,
  slugDaPasta,
  urlPublica,
} from "./_storage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL_PADRAO = "https://manywata.vercel.app";
const ROTA = "/api/midia/publicar";
const USO = [
  "Uso: node scripts/midia.mjs publicar <pasta-render> --confirmar [--conta eterniza] [--base-url <url-https-pública>] [--dry-run]",
  "     node scripts/midia.mjs story <arquivo.jpg> --confirmar [--conta eterniza] [--base-url <url-https-pública>] [--dry-run]",
  "     node scripts/midia.mjs limpar <prefixo> --confirmar",
].join("\n");
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
// sai com 1. Injeção (fetch, lerVar, env, log, avisar, agora, sufixo,
// timeoutRotaMs) é pros testes. SUPABASE_* vêm só de `env` (process.env),
// nunca do .env.local.
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
    timeoutRotaMs = CLI_TIMEOUT_ROTA_MS,
  } = {}
) {
  const [comando, ...resto] = argv;
  const opt = (flag) => {
    const i = resto.indexOf(flag);
    return i >= 0 && resto[i + 1] && !resto[i + 1].startsWith("--") ? resto[i + 1] : undefined;
  };
  const tem = (flag) => resto.includes(flag);

  if (comando === "limpar") return limpar({ resto, tem, env, fetch, log });
  const io = { fetch, lerVar, env, log, avisar, agora, sufixo, timeoutRotaMs };
  if (comando === "story") return story({ resto, tem, opt, ...io });
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
    return chamarRota({ fetch, base, segredo: exigirSegredo(lerVar), corpo: c, log, timeoutMs: timeoutRotaMs });
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

  if (dryRun) {
    dryRunStorage({ env, prefixo, nomes: slides, montarCorpo: corpo, mostrarDryRun, log });
    return null;
  }
  return publicarViaStorage({ arquivos, prefixo, cred, segredo, montarCorpo: corpo, conta, base, fetch, log, avisar, timeoutRotaMs });
}

// ── story <arquivo.jpg> ───────────────────────────────────────────────────

// Story de UMA imagem JPEG, sem legenda (a API não aceita caption em
// STORIES). Mesmo fluxo do publicar: valida tudo sem rede, sobe pro
// instagram-temp/<slug-do-arquivo>-<carimbo>/<slug-do-arquivo>.jpg, chama a
// rota com tipo STORIES e apaga só quando o resultado é definido.
async function story({ resto, tem, opt, fetch, lerVar, env, log, avisar, agora, sufixo, timeoutRotaMs }) {
  if (!tem("--confirmar")) {
    throw new Error("Recusado: story exige --confirmar. Só rode com o ok do Vinicius na imagem.");
  }
  const arquivo = resto[0] && !resto[0].startsWith("--") ? resto[0] : undefined;
  if (!arquivo) throw new Error(`Falta o arquivo JPEG do story.\n${USO}`);

  // Mesma checagem dos slides do carrossel: <= 8 MB e começa com FF D8 FF.
  const nome = basename(arquivo);
  let bytes;
  try {
    [{ bytes }] = lerSlidesJpeg(dirname(arquivo), [nome]);
  } catch (e) {
    if (e?.code) throw new Error(`Não consegui ler o arquivo ${arquivo}.`); // ENOENT, EISDIR, ...
    throw e;
  }
  avisarDimensoes(bytes, nome, avisar);

  const conta = opt("--conta") || "eterniza";
  // Sem legenda: o campo nem vai no corpo.
  const corpo = (urls) => ({ conta, tipo: "STORIES", itens: urls.map((url) => ({ url })), confirmar: true });
  const base = (lerVar("MANYWATA_URL") || URL_PADRAO).replace(/\/$/, "");
  const dryRun = tem("--dry-run");
  const mostrarDryRun = (c) => {
    log(`[dry-run] POST ${base}${ROTA}  (nada foi enviado)`);
    log(JSON.stringify(c, null, 2));
  };

  // ── Com --base-url: a imagem já está em <base-url>/<nome do arquivo> ──
  const baseUrl = opt("--base-url");
  if (baseUrl) {
    const c = corpo(montarUrls(baseUrl, [nome]));
    if (dryRun) {
      mostrarDryRun(c);
      return null;
    }
    return chamarRota({ fetch, base, segredo: exigirSegredo(lerVar), corpo: c, log, timeoutMs: timeoutRotaMs });
  }

  // ── Sem --base-url: Storage ──
  const cred = dryRun ? null : lerCredenciaisStorage(env);
  const segredo = dryRun ? null : exigirSegredo(lerVar);
  const slug = sanitizarSlug(nome.replace(/\.[^.]*$/, ""), "story");
  const prefixo = `${slug}-${carimbo(agora(), sufixo)}`;
  const nomeNoBucket = `${slug}.jpg`;

  if (dryRun) {
    dryRunStorage({ env, prefixo, nomes: [nomeNoBucket], montarCorpo: corpo, mostrarDryRun, log });
    return null;
  }
  return publicarViaStorage({
    arquivos: [{ nome: nomeNoBucket, bytes }],
    prefixo,
    cred,
    segredo,
    montarCorpo: corpo,
    conta,
    base,
    fetch,
    log,
    avisar,
    timeoutRotaMs,
  });
}

// Story é 9:16; o recomendado é 1080x1920. Fora disso o Instagram corta ou
// põe borda, mas publica: só avisa.
export const STORY_LARGURA = 1080;
export const STORY_ALTURA = 1920;
function avisarDimensoes(bytes, nome, avisar) {
  const d = dimensoesJpeg(bytes);
  if (!d) {
    avisar(`aviso: não consegui ler as dimensões de ${nome}; o recomendado pra story é ${STORY_LARGURA}x${STORY_ALTURA}. Seguindo mesmo assim.`);
  } else if (d.largura !== STORY_LARGURA || d.altura !== STORY_ALTURA) {
    avisar(
      `aviso: ${nome} tem ${d.largura}x${d.altura}; o recomendado pra story é ${STORY_LARGURA}x${STORY_ALTURA} (9:16). O Instagram pode cortar ou pôr borda. Seguindo mesmo assim.`
    );
  }
}

// ── Partes comuns do fluxo com Storage (publicar e story) ─────────────────

function dryRunStorage({ env, prefixo, nomes, montarCorpo, mostrarDryRun, log }) {
  let credDry = null;
  try {
    credDry = lerCredenciaisStorage(env);
  } catch {
    // só avisa
  }
  const caminhos = montarCaminhos(prefixo, nomes);
  log(`[dry-run] subiria ${caminhos.length} JPEG(s) pro Supabase Storage (nada foi enviado):`);
  for (const c of caminhos) log(`  ${BUCKET}/${c}`);
  if (!credDry) {
    log("  aviso: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes ou inválidas no ambiente; o publicar de verdade vai recusar.");
  }
  mostrarDryRun(montarCorpo(caminhos.map((c) => urlPublica(credDry?.url ?? "<SUPABASE_URL>", c))));
  log(`[dry-run] depois de publicar, apagaria ${BUCKET}/${prefixo}/ (se o resultado for definido)`);
}

// Sobe, chama a rota e apaga os temporários SÓ quando o resultado é
// definido (ver "Limpeza" no topo do arquivo).
async function publicarViaStorage({ arquivos, prefixo, cred, segredo, montarCorpo, conta, base, fetch, log, avisar, timeoutRotaMs }) {
  const limpo = (texto) => sanitizar(texto, [cred.chave, segredo]);

  let enviados = [];
  let apagar = true; // vira false quando o resultado da rota é INDEFINIDO
  try {
    log(`Subindo ${arquivos.length} JPEG(s) para ${BUCKET}/${prefixo}/ ...`);
    let urls;
    try {
      ({ caminhos: enviados, urls } = await enviarParaStorage({ arquivos, prefixo, cred, fetch }));
    } catch (e) {
      // A rota não foi chamada: definido, nada publicado, apaga o que subiu.
      enviados = e.caminhos ?? [];
      throw new Error(`${e.message}\nNada foi publicado.`);
    }
    return await chamarRota({ fetch, base, segredo, corpo: montarCorpo(urls), log, timeoutMs: timeoutRotaMs });
  } catch (e) {
    let msg = e?.message;
    if (e?.indefinido) {
      apagar = false;
      msg += `\n${instrucoesIndefinido({ prefixo, enviados, conta })}`;
    }
    throw new Error(limpo(msg));
  } finally {
    if (enviados.length && apagar) {
      try {
        await apagarDoStorage({ caminhos: enviados, cred, fetch });
        log(`Temporários apagados de ${BUCKET}/${prefixo}/.`);
      } catch (e) {
        avisar(
          limpo(
            [
              `aviso: não consegui apagar os temporários do Storage (${e?.message}).`,
              `Apague depois com: node scripts/midia.mjs limpar ${prefixo} --confirmar`,
              "ou à mão no painel do Supabase (Storage → instagram-temp):",
              ...enviados.map((c) => `  ${BUCKET}/${c}`),
            ].join("\n")
          )
        );
      }
    }
  }
}

function instrucoesIndefinido({ prefixo, enviados, conta }) {
  return [
    "",
    `Os temporários NÃO foram apagados (o Instagram pode ainda estar processando containers que apontam pra eles):`,
    ...enviados.map((c) => `  ${BUCKET}/${c}`),
    "O que fazer:",
    `  1. Confira o perfil da conta "${conta}" (pode levar alguns minutos pra aparecer).`,
    "  2. Se NÃO publicou: rode o mesmo comando de novo (sobe numa pasta nova do bucket).",
    "  3. Depois (publicado ou não), apague estes temporários:",
    `       node scripts/midia.mjs limpar ${prefixo} --confirmar`,
    "     ou à mão no painel do Supabase (Storage → instagram-temp).",
  ].join("\n");
}

function exigirSegredo(lerVar) {
  const segredo = lerVar("PUBLICAR_SECRET");
  if (!segredo) throw new Error("PUBLICAR_SECRET não achado no ambiente nem no .env.local.");
  return segredo;
}

// Erro de resultado INDEFINIDO: pode ter publicado (ou containers ainda em
// processamento). Quem chama NÃO apaga os temporários.
function indefinido(mensagem) {
  const e = new Error(mensagem);
  e.indefinido = true;
  return e;
}

async function chamarRota({ fetch, base, segredo, corpo, log, timeoutMs }) {
  const ehStory = corpo.tipo === "STORIES";
  const oQue = ehStory ? "story (1 imagem)" : `carrossel (${corpo.itens.length} slides)`;
  log(`Publicando ${oQue} em "${corpo.conta}"... pode levar alguns minutos (a rota tem até ${MAX_DURATION_S}s).`);
  let r;
  try {
    r = await fetch(`${base}${ROTA}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${segredo}`, "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      // maior que o maxDuration da função: se estourar, a Vercel já
      // respondeu (ou caiu) antes; não ficar pendurado pra sempre.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const abortou = e?.name === "TimeoutError" || e?.name === "AbortError";
    throw indefinido(
      abortou
        ? `Sem resposta de ${base}${ROTA} em ${Math.round(timeoutMs / 1000)}s (timeout do CLI).\nPode ter publicado mesmo assim: ${CONFERIR}`
        : `Falha de rede chamando ${base}${ROTA}: ${e?.message}\nPode ter publicado mesmo assim: ${CONFERIR}`
    );
  }
  const dados = await r.json().catch(() => null);
  const objeto = dados && typeof dados === "object" && !Array.isArray(dados) ? dados : null;

  if (r.ok) {
    if (!objeto?.mediaId) {
      throw indefinido(`HTTP ${r.status} sem mediaId na resposta: pode ter publicado, ${CONFERIR}`);
    }
    // Story pode vir sem permalink; é normal, o media_id já confirma.
    const semLink = ehStory ? "(story sem permalink; normal, o media_id confirma)" : "(permalink indisponível)";
    log(`Publicado em @${objeto.username}: ${objeto.permalink || semLink}`);
    log(`  media_id: ${objeto.mediaId}  ·  cota 24h: ${objeto.quota?.usado}/${objeto.quota?.total}`);
    if (objeto.aviso) log(`  aviso: ${objeto.aviso}`);
    return objeto;
  }

  const erro = typeof objeto?.erro === "string" && objeto.erro ? objeto.erro : null;
  const naoPublicou = Boolean(erro) && objeto.publicado === false;
  const cabecalho = `HTTP ${r.status}: ${erro || "sem detalhe"}`;

  if (naoPublicou && r.status !== 504) {
    // Definido: a rota garante que não chamou o media_publish.
    throw new Error(`${cabecalho}\nNada foi publicado.`);
  }
  if (naoPublicou) {
    // 504 da nossa rota: o media_publish não foi chamado, mas os containers
    // podem seguir processando. Conservador: não apaga (ver topo do arquivo).
    throw indefinido(
      `${cabecalho}\nA rota não chegou a publicar (publicado: false), mas o Instagram ainda pode estar processando os containers. Confira o perfil e rode de novo.`
    );
  }
  throw indefinido(
    erro
      ? `${cabecalho}\nA rota não confirmou se publicou: pode ter publicado, ${CONFERIR}`
      : `${cabecalho}\nResposta sem detalhe (timeout da Vercel?): pode ter publicado, ${CONFERIR}`
  );
}

// ── limpar ────────────────────────────────────────────────────────────────

// Apaga tudo de UMA pasta do instagram-temp. Exige --confirmar. Só use
// depois de conferir o perfil (ou com certeza de que nada está publicando).
async function limpar({ resto, tem, env, fetch, log }) {
  const alvo = resto[0] && !resto[0].startsWith("--") ? resto[0] : undefined;
  if (!alvo) throw new Error(`Falta o prefixo.\n${USO}`);
  const prefixo = normalizarPrefixo(alvo);
  if (!tem("--confirmar")) {
    throw new Error(
      `Recusado: limpar exige --confirmar (apaga ${BUCKET}/${prefixo}/). Confira antes se a publicação terminou (perfil no ar ou erro definitivo).`
    );
  }
  const cred = lerCredenciaisStorage(env);
  const limpo = (texto) => sanitizar(texto, [cred.chave]);
  try {
    const caminhos = await listarDoStorage({ prefixo, cred, fetch });
    if (!caminhos.length) {
      log(`Nada pra apagar em ${BUCKET}/${prefixo}/.`);
      return { apagados: [] };
    }
    await apagarDoStorage({ caminhos, cred, fetch });
    log(`Apagados ${caminhos.length} arquivo(s) de ${BUCKET}/${prefixo}/:`);
    for (const c of caminhos) log(`  ${BUCKET}/${c}`);
    return { apagados: caminhos };
  } catch (e) {
    throw new Error(limpo(e?.message));
  }
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
