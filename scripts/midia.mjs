// CLI pra publicar um carrossel, um story ou um Reels aprovado. publicar e
// story falam com POST /api/midia/publicar do MANYWATA (não com o Instagram
// direto). reels fala DIRETO com o Instagram (upload resumível, ver abaixo):
// não passa pela rota nem pelo Supabase.
//
// Uso:
//   node scripts/midia.mjs publicar <pasta-render> --confirmar [--conta eterniza] [--base-url <url>] [--dry-run]
//   node scripts/midia.mjs story <arquivo.jpg> --confirmar [--conta eterniza] [--base-url <url>] [--dry-run]
//   node scripts/midia.mjs reels <arquivo.mp4> --legenda <arquivo.txt> [--capa <arquivo.jpg> | --thumb-offset <ms>] --confirmar [--conta eterniza] [--dry-run]
//   node scripts/midia.mjs limpar <prefixo> --confirmar
//
// Só rode o publicar/story/reels com o ok do Vinicius na mídia e no texto: a
// chamada publica direto, não tem rascunho. publicar e story sem --confirmar
// recusam. reels sem --confirmar NÃO recusa: vira dry-run (valida o vídeo,
// mostra o que faria e não chama rede nenhuma).
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
// reels: 1 vídeo MP4 (ou MOV) + --legenda <arquivo.txt> (obrigatório; não
// procura instagram-post.txt sozinho). Antes de qualquer rede: assinatura
// ftyp, até 300 MB e, com ffprobe no PATH, duração de 3s a 15min e container
// mp4/mov (bloqueia); 9:16, fps, codec e bitrate só avisam (scripts/_video.mjs).
// Sem ffprobe, avisa que a duração não foi conferida e segue.
// Capa (opcional, uma OU outra; as duas juntas recusam sem rede):
//   --capa <arquivo.jpg>  JPEG (FF D8 FF, até 8 MB) que sobe pro
//                         instagram-temp/<slug-do-vídeo>-<carimbo>/<slug>.jpg
//                         e vai como cover_url; apagado com a mesma regra
//                         de limpeza do publicar/story (abaixo).
//   --thumb-offset <ms>   frame do próprio vídeo (thumb_offset, inteiro >= 0);
//                         sem upload.
//   nenhuma               o Instagram escolhe o frame.
// Com --confirmar (e sem --dry-run), fala direto com o Instagram:
//   1. cota de 24h (content_publishing_limit) antes de criar container;
//   2. (só com --capa) sobe o JPEG da capa pro Storage;
//   3. POST /{ig-user-id}/media com media_type=REELS, upload_type=resumable,
//      caption e cover_url OU thumb_offset → { id, uri } (só aceita uri em
//      rupload.facebook.com/ig-api-upload/);
//   4. POST do MP4 inteiro na uri (Authorization: OAuth, offset 0, file_size);
//   5. polling do status_code até FINISHED (até CLI_REELS_STATUS_TIMEOUT_MS);
//   6. media_publish e permalink.
// O vídeo de 48 MB não passa pela função da Vercel (limite de 4,5 MB de
// request) nem pelo Supabase: o MP4 nunca sobe pro instagram-temp. --base-url
// não vale mais pro reels (recusa).
// RISCO: o MANYWATA usa Instagram Login (graph.instagram.com) e a doc do Meta
// descreve o upload resumível (rupload) pra Facebook Login for Business. Se o
// Meta recusar, o erro sai sanitizado e nada é publicado.
// Token: SÓ do ambiente, na env do tokenEnv da conta em api/contas.js
// (--conta eterniza → IG_ACCESS_TOKEN_ETERNIZA). Nunca do .env.local, nunca
// de argv, nunca impresso. O operador carrega de um arquivo protegido:
//   set -a; . <arquivo-com-o-token>; set +a
// Resultado:
//   - falhou ANTES do media_publish (validação, cota, container, upload,
//     ERROR, EXPIRED, timeout do status) → DEFINIDO, nada publicado;
//   - falhou no media_publish ou depois de dispará-lo sem resposta clara →
//     INDEFINIDO: confira o perfil, não rode de novo no escuro.
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
// No reels a limpeza vale só pra capa (--capa): DEFINIDO (sucesso ou falha
// antes do media_publish: cota, container, rupload, ERROR, EXPIRED, timeout
// do status) apaga o JPEG; INDEFINIDO (media_publish chamado sem resposta
// clara) mantém e mostra o `limpar`. O MP4 não está no Storage.
//
// --dry-run: mostra o que mandaria (e os caminhos no Storage) e não chama nada.
// No reels, --dry-run ou falta de --confirmar dão o mesmo dry-run: mostra os
// passos (conta, tamanho, caption, capa/caminho no bucket/cover_url ou
// thumb_offset, container resumível, upload, FINISHED, media_publish), zero
// fetch, e não exige o token nem SUPABASE_* (só avisa se faltarem).
//
// publicar/story leem PUBLICAR_SECRET e MANYWATA_URL do ambiente ou do
// .env.local. reels não usa nenhum dos dois. Nunca imprime segredo, chave
// nem token.

import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sanitizar } from "../api/_lib/seguranca.js";
import { CONTAS, contaPorSlug, tokenDaConta } from "../api/contas.js";
import { DICA_ERRO_VIDEO_UPLOAD, RUPLOAD_HOST, criarPublicador, validarLegenda } from "../api/_lib/instagram-publicacao.js";
import {
  CLI_REELS_STATUS_TIMEOUT_MS,
  CLI_RUPLOAD_TIMEOUT_MS,
  CLI_TIMEOUT_ROTA_MS,
  MAX_DURATION_S,
} from "../api/_lib/tempos.js";
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
import { ffprobePadrao, validarVideoReels } from "./_video.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL_PADRAO = "https://manywata.vercel.app";
const ROTA = "/api/midia/publicar";
const USO = [
  "Uso: node scripts/midia.mjs publicar <pasta-render> --confirmar [--conta eterniza] [--base-url <url-https-pública>] [--dry-run]",
  "     node scripts/midia.mjs story <arquivo.jpg> --confirmar [--conta eterniza] [--base-url <url-https-pública>] [--dry-run]",
  "     node scripts/midia.mjs reels <arquivo.mp4> --legenda <arquivo.txt> [--capa <arquivo.jpg> | --thumb-offset <ms>] --confirmar [--conta eterniza] [--dry-run]",
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
// timeoutRotaMs, ffprobe, sleep, now, timeoutStatusMs, timeoutRuploadMs) é
// pros testes. SUPABASE_* e o token do Instagram (reels) vêm só de `env`
// (process.env), nunca do .env.local.
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
    ffprobe = ffprobePadrao,
    sleep,
    now,
    timeoutStatusMs = CLI_REELS_STATUS_TIMEOUT_MS,
    timeoutRuploadMs = CLI_RUPLOAD_TIMEOUT_MS,
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
  if (comando === "reels") {
    return reels({ resto, tem, opt, fetch, env, log, avisar, agora, sufixo, ffprobe, sleep, now, timeoutStatusMs, timeoutRuploadMs });
  }
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

// ── reels <arquivo.mp4> --legenda <arquivo.txt> ───────────────────────────

// Reels de 1 vídeo. Diferente de publicar/story: sem --confirmar NÃO recusa,
// faz dry-run (valida, mostra o que faria, zero rede). Com --dry-run também.
// Só --confirmar sem --dry-run publica, falando DIRETO com o Instagram
// (container resumível + rupload; ver o topo do arquivo). A rota não entra; o
// Supabase só entra com --capa, e só pro JPEG da capa.
async function reels({ resto, tem, opt, fetch, env, log, avisar, agora, sufixo, ffprobe, sleep, now, timeoutStatusMs, timeoutRuploadMs }) {
  // Antes de tudo (sem rede): --base-url era do fluxo antigo (URL hospedada).
  if (tem("--base-url")) {
    throw new Error(
      "Recusado: reels não usa mais --base-url. O vídeo vai direto do arquivo local pro upload resumível do Instagram (rupload), sem URL hospedada. Tire o --base-url. Nada foi enviado."
    );
  }
  // Capa: --capa <arquivo.jpg> OU --thumb-offset <ms>, nunca as duas.
  const querCapa = tem("--capa");
  const querOffset = tem("--thumb-offset");
  if (querCapa && querOffset) {
    throw new Error(
      "Recusado: use --capa <arquivo.jpg> OU --thumb-offset <ms>, não os dois (com cover_url o Instagram ignora o thumb_offset). Nada foi enviado."
    );
  }
  const arquivoCapa = opt("--capa");
  if (querCapa && !arquivoCapa) throw new Error(`Falta o arquivo JPEG depois de --capa. Nada foi enviado.\n${USO}`);
  let thumbOffset;
  if (querOffset) {
    const bruto = opt("--thumb-offset");
    if (bruto === undefined || !/^\d+$/.test(bruto) || !Number.isSafeInteger(Number(bruto))) {
      throw new Error(
        `--thumb-offset precisa ser um inteiro >= 0 em milissegundos (ex.: --thumb-offset 1500 = frame em 1,5s); veio "${bruto ?? ""}". Nada foi enviado.`
      );
    }
    thumbOffset = Number(bruto);
  }

  const arquivo = resto[0] && !resto[0].startsWith("--") ? resto[0] : undefined;
  if (!arquivo) throw new Error(`Falta o arquivo MP4 do Reels.\n${USO}`);

  // Legenda: só de --legenda (não procura instagram-post.txt sozinho).
  const arquivoLegenda = opt("--legenda");
  if (!arquivoLegenda) throw new Error(`Falta --legenda <arquivo.txt> (a legenda do Reels). Nada foi enviado.\n${USO}`);
  let legenda;
  try {
    legenda = readFileSync(arquivoLegenda, "utf8");
  } catch {
    throw new Error(`Não consegui ler a legenda em ${arquivoLegenda}. Nada foi enviado.`);
  }
  let caption;
  try {
    caption = validarLegenda(legenda); // mesmos limites da rota (2200 caracteres, 30 hashtags, 20 @)
  } catch (e) {
    throw new Error(`${arquivoLegenda}: ${e.message} Nada foi enviado.`);
  }

  // Vídeo: existência, assinatura, 300 MB, duração (ffprobe). Sem rede. Sem
  // limite de 8 MB: o vídeo não passa pelo bucket.
  const video = validarVideoReels(arquivo, { ffprobe });
  for (const l of video.linhas) log(l);
  for (const a of video.avisos) avisar(a);
  const duracaoS = video.resumo?.duracaoS;
  if (thumbOffset !== undefined && typeof duracaoS === "number" && thumbOffset > duracaoS * 1000) {
    avisar(
      `aviso: --thumb-offset ${thumbOffset} ms passa da duração do vídeo (${Math.round(duracaoS * 1000)} ms); o Instagram pode recusar ou escolher outro frame.`
    );
  }

  // Capa: mesma checagem do story/carrossel (FF D8 FF, até 8 MB). Sem rede.
  let capa = null;
  if (arquivoCapa) {
    const nomeCapa = basename(arquivoCapa);
    let bytes;
    try {
      [{ bytes }] = lerSlidesJpeg(dirname(arquivoCapa), [nomeCapa]);
    } catch (e) {
      if (e?.code) throw new Error(`--capa: não consegui ler o arquivo ${arquivoCapa}. Nada foi enviado.`); // ENOENT, EISDIR, ...
      throw new Error(`--capa: ${e.message}`);
    }
    capa = { arquivo: nomeCapa, bytes };
  }

  // Conta e nome da env do token (sem ler o valor ainda).
  const slugConta = opt("--conta") || "eterniza";
  const conta = contaPorSlug(slugConta);
  if (!conta) {
    throw new Error(`Conta "${slugConta}" desconhecida. Contas: ${CONTAS.map((c) => c.slug).join(", ")}. Nada foi enviado.`);
  }
  const nomeEnv = conta.tokenEnv;
  const token = String(tokenDaConta(conta, env) ?? "").trim();

  // Caminho da capa no bucket: <slug-do-vídeo>-<carimbo>/<slug-do-vídeo>.jpg
  let prefixo, caminhoCapa;
  if (capa) {
    const slug = sanitizarSlug(video.nome.replace(/\.[^.]*$/, ""), "reels");
    prefixo = `${slug}-${carimbo(agora(), sufixo)}`;
    capa.nome = `${slug}.jpg`;
    [caminhoCapa] = montarCaminhos(prefixo, [capa.nome]);
  }

  const dryRun = tem("--dry-run") || !tem("--confirmar");
  if (dryRun) {
    dryRunReels({
      conta,
      nomeEnv,
      temToken: Boolean(token),
      video,
      caption,
      capa,
      caminhoCapa,
      prefixo,
      thumbOffset,
      env,
      confirmar: tem("--confirmar"),
      timeoutStatusMs,
      log,
    });
    return null;
  }
  if (!token) {
    throw new Error(
      [
        `Recusado: ${nomeEnv} não está no ambiente (token da conta "${conta.slug}").`,
        "O reels lê o token SÓ do ambiente (nunca do .env.local nem de argumento). Carregue do arquivo protegido no terminal:",
        "  set -a; . <arquivo-com-o-token>; set +a",
        "Nada foi enviado.",
      ].join("\n")
    );
  }
  // Supabase só com --capa (e só do ambiente, como no publicar/story).
  let cred = null;
  if (capa) {
    try {
      cred = lerCredenciaisStorage(env);
    } catch (e) {
      const msg = String(e?.message).replace(/\nOu passe --base-url[\s\S]*$/, "");
      throw new Error(
        `Recusado: --capa sobe o JPEG pro ${BUCKET}. ${msg}\nSem Supabase: use --thumb-offset <ms> (frame do próprio vídeo) ou publique sem capa. Nada foi enviado.`
      );
    }
  }

  // Só aqui lê o vídeo inteiro (até 300 MB, já validado).
  const bytes = readFileSync(arquivo);
  return publicarReelsResumivel({
    conta,
    token,
    bytes,
    tamanho: bytes.length,
    nome: video.nome,
    caption,
    capa,
    prefixo,
    cred,
    thumbOffset,
    fetch,
    sleep,
    now,
    log,
    avisar,
    timeoutStatusMs,
    timeoutRuploadMs,
  });
}

const minutos = (ms) => `${Math.round(ms / 60_000)}min`;

function dryRunReels({ conta, nomeEnv, temToken, video, caption, capa, caminhoCapa, prefixo, thumbOffset, env, confirmar, timeoutStatusMs, log }) {
  if (!confirmar) {
    log("[dry-run] sem --confirmar: só mostrando o que seria feito. Pra publicar (com o ok do Vinicius), rode de novo com --confirmar.");
  }
  log("[dry-run] nada foi enviado. Passos do --confirmar, direto com o Instagram (sem a rota; o MP4 não passa pelo Supabase):");
  log(`  conta: ${conta.slug} (@${conta.username}, ig-user-id ${conta.userId})`);
  log(`  vídeo: ${video.nome}, ${video.tamanho} bytes`);
  log(`  caption (${Array.from(caption).length} caracteres):`);
  log(caption ? caption.split("\n").map((l) => `    | ${l}`).join("\n") : "    (vazia: o container vai sem caption)");

  let credDry = null;
  if (capa) {
    try {
      credDry = lerCredenciaisStorage(env);
    } catch {
      // só avisa lá embaixo
    }
  }
  let extra = caption ? " + caption" : "";
  if (capa) extra += " + cover_url";
  if (thumbOffset !== undefined) extra += ` + thumb_offset=${thumbOffset}`;

  log(`  1. checaria a cota de 24h (GET /${conta.userId}/content_publishing_limit)`);
  if (capa) {
    log(`  2. subiria a capa ${capa.arquivo} (${capa.bytes.length} bytes, image/jpeg) pro Supabase Storage:`);
    log(`       ${BUCKET}/${caminhoCapa}`);
    log(`     cover_url: ${urlPublica(credDry?.url ?? "<SUPABASE_URL>", caminhoCapa)}`);
  } else if (thumbOffset !== undefined) {
    log(`  2. capa: frame do vídeo em ${thumbOffset} ms (thumb_offset=${thumbOffset}; sem upload)`);
  } else {
    log("  2. capa: nenhuma (o Instagram escolhe o frame)");
  }
  log(`  3. criaria container: POST /${conta.userId}/media media_type=REELS upload_type=resumable${extra}`);
  log(`  4. subiria ${video.tamanho} bytes pro rupload (${RUPLOAD_HOST}, Authorization: OAuth, offset 0, file_size ${video.tamanho})`);
  log(`  5. esperaria status_code FINISHED (até ${minutos(timeoutStatusMs)})`);
  log("  6. chamaria media_publish e buscaria o permalink");
  if (capa) log(`  7. apagaria ${BUCKET}/${prefixo}/ (se o resultado for definido)`);
  if (!temToken) {
    log(`  aviso: ${nomeEnv} não está no ambiente; o --confirmar vai recusar. Carregue com: set -a; . <arquivo-com-o-token>; set +a`);
  }
  if (capa && !credDry) {
    log("  aviso: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes ou inválidas no ambiente; o --confirmar com --capa vai recusar.");
  }
}

// Fluxo do Reels direto com o Instagram. Até o media_publish, qualquer falha
// é DEFINIDA (nada publicado). Do media_publish em diante, INDEFINIDA.
// Com capa: o JPEG sobe pro instagram-temp antes do container e segue a
// mesma regra de limpeza do publicar/story: DEFINIDO apaga, INDEFINIDO
// mantém e mostra o `limpar`. O MP4 nunca vai pro Storage.
async function publicarReelsResumivel({
  conta,
  token,
  bytes,
  tamanho,
  nome,
  caption,
  capa,
  prefixo,
  cred,
  thumbOffset,
  fetch,
  sleep,
  now,
  log,
  avisar,
  timeoutStatusMs,
  timeoutRuploadMs,
}) {
  const limpo = (texto) => sanitizar(texto, [token, cred?.chave]);
  const pub = criarPublicador({ userId: conta.userId, token, fetch, ...(sleep ? { sleep } : {}), ...(now ? { now } : {}) });

  let containerId;
  let enviados = []; // caminhos da capa no Storage (o que foi tentado)
  let apagar = true; // vira false quando o resultado é INDEFINIDO
  try {
    // 1. cota
    const quota = await pub.checarLimitePublicacao();
    if (quota.atingido) {
      throw new Error(`Limite de publicação de 24h atingido em @${conta.username} (${quota.usado}/${quota.total}). Nenhum container criado.`);
    }
    log(`Cota 24h de @${conta.username}: ${quota.usado}/${quota.total}.`);

    // 2. capa (opcional) pro Storage, mesmo caminho do publicar/story
    let coverUrl;
    if (capa) {
      log(`Subindo a capa ${capa.arquivo} para ${BUCKET}/${prefixo}/ ...`);
      try {
        const r = await enviarParaStorage({ arquivos: [{ nome: capa.nome, bytes: capa.bytes, contentType: "image/jpeg" }], prefixo, cred, fetch });
        enviados = r.caminhos;
        [coverUrl] = r.urls;
      } catch (e) {
        enviados = e.caminhos ?? []; // pode ter chegado ao servidor: apaga
        throw e;
      }
    }

    // 3. container resumível
    const container = await pub.criarContainerResumivel({ legenda: caption, coverUrl, thumbOffset });
    containerId = container.id;
    const capaTxt = coverUrl ? ", cover_url" : thumbOffset !== undefined ? `, thumb_offset=${thumbOffset}` : "";
    log(`Container REELS ${containerId} criado (upload_type=resumable${capaTxt}).`);

    // 4. upload do binário
    log(`Subindo ${nome} (${tamanho} bytes) pro ${RUPLOAD_HOST}... (até ${minutos(timeoutRuploadMs)})`);
    await pub.enviarVideoResumivel(container.uri, { corpo: bytes, tamanho, timeoutMs: timeoutRuploadMs });
    log("Upload concluído.");

    // 5. processamento
    log(`Esperando o Instagram processar o vídeo (status FINISHED, até ${minutos(timeoutStatusMs)})...`);
    await pub.aguardarStatus(containerId, { timeoutMs: timeoutStatusMs, dica: DICA_ERRO_VIDEO_UPLOAD });

    // 6. publicar (daqui em diante, erro = indefinido)
    log(`Publicando o Reels em @${conta.username}...`);
    let mediaId;
    try {
      mediaId = await pub.publicarContainer(containerId);
    } catch (e) {
      throw indefinido(
        [
          `media_publish do container ${containerId} falhou: ${e?.message}`,
          "Resultado INDEFINIDO: o media_publish foi chamado e pode ter publicado.",
          `Confira o perfil @${conta.username} (pode levar alguns minutos pra aparecer) ANTES de rodar de novo. Não republique no escuro.`,
        ].join("\n")
      );
    }

    let permalink = null;
    let aviso;
    try {
      permalink = await pub.buscarPermalink(mediaId);
      if (!permalink) aviso = "Instagram não devolveu o permalink; o media_id confirma a publicação.";
    } catch (e) {
      aviso = `publicado, mas não deu pra buscar o permalink: ${e?.message}`;
    }
    log(`Publicado em @${conta.username}: ${permalink || "(permalink indisponível)"}`);
    log(`  media_id: ${mediaId}  ·  cota 24h antes de publicar: ${quota.usado}/${quota.total}`);
    if (aviso) avisar(limpo(`aviso: ${aviso}`));
    return {
      mediaId,
      permalink,
      username: conta.username,
      quota: { usado: quota.usado, total: quota.total },
      conta: conta.slug,
      tipo: "REELS",
      containerId,
      ...(aviso ? { aviso: limpo(aviso) } : {}),
    };
  } catch (e) {
    if (e?.indefinido) {
      apagar = false;
      const linhas = [e.message];
      if (enviados.length) {
        linhas.push(
          "",
          "A capa NÃO foi apagada do Storage (o Instagram pode ainda estar usando):",
          ...enviados.map((c) => `  ${BUCKET}/${c}`),
          "Depois de conferir o perfil (publicado ou não), apague com:",
          `  node scripts/midia.mjs limpar ${prefixo} --confirmar`,
          "  ou à mão no painel do Supabase (Storage → instagram-temp)."
        );
      }
      const erro = new Error(limpo(linhas.join("\n")));
      erro.indefinido = true;
      throw erro;
    }
    // Antes do media_publish: definido. O container (se criado) não aparece
    // no perfil e o Instagram descarta sozinho. A capa (se subiu) é apagada
    // no finally.
    const msg = String(e?.message ?? e);
    const linhas = [msg];
    if (!/Nada foi publicado/i.test(msg)) linhas.push("Nada foi publicado.");
    if (containerId) linhas.push(`O container ${containerId} não foi publicado (não aparece no perfil; o Instagram descarta sozinho).`);
    throw new Error(limpo(linhas.join("\n")));
  } finally {
    if (enviados.length && apagar) {
      try {
        await apagarDoStorage({ caminhos: enviados, cred, fetch });
        log(`Capa temporária apagada de ${BUCKET}/${prefixo}/.`);
      } catch (e) {
        avisar(
          limpo(
            [
              `aviso: não consegui apagar a capa temporária do Storage (${e?.message}).`,
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

// ── Partes comuns do fluxo com Storage (publicar, story e reels) ──────────

function dryRunStorage({ env, prefixo, nomes, montarCorpo, mostrarDryRun, log }) {
  let credDry = null;
  try {
    credDry = lerCredenciaisStorage(env);
  } catch {
    // só avisa
  }
  const caminhos = montarCaminhos(prefixo, nomes);
  log(`[dry-run] subiria ${caminhos.length} arquivo(s) pro Supabase Storage (nada foi enviado):`);
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
    log(`Subindo ${arquivos.length} arquivo(s) para ${BUCKET}/${prefixo}/ ...`);
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
  // (reels não passa por aqui: fala direto com o Instagram)
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
