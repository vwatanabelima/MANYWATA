// Validação local do vídeo do Reels, antes de qualquer rede.
//
// Limites DUROS (a API do Instagram recusa; o CLI bloqueia):
//   - container MP4/MOV (assinatura ftyp no arquivo; ffprobe confirma)
//   - até 300 MB (300 * 1024 * 1024)
//   - duração de 3s a 15min
// RECOMENDAÇÕES (o Instagram aceita, mas pode cortar/reprocessar; só avisa):
//   - 9:16 (1080x1920 é o típico), largura até 1920
//   - 23 a 60 fps
//   - vídeo H.264 ou HEVC até 25 Mbps; áudio AAC até 128 kbps
//
// Duração, codec, resolução e fps vêm do ffprobe, SE ele existir no PATH.
// Sem ffprobe: confere existência, tamanho e assinatura, e avisa que a
// duração não foi conferida (não bloqueia só por isso). O ffprobe é
// injetável (opção `ffprobe`) pra testar sem binário nem vídeo de verdade:
// recebe o caminho e devolve o JSON do `ffprobe -show_format -show_streams`
// já parseado, ou null quando não há ffprobe.

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

export const REELS_MAX_BYTES = 300 * 1024 * 1024;
export const REELS_MIN_DURACAO_S = 3;
export const REELS_MAX_DURACAO_S = 15 * 60;
export const REELS_RECOMENDADO = {
  largura: 1080,
  altura: 1920,
  larguraMax: 1920,
  fpsMin: 23,
  fpsMax: 60,
  videoCodecs: ["h264", "hevc"],
  audioCodecs: ["aac"],
  videoMaxBps: 25_000_000,
  audioMaxBps: 128_000,
};

const EXTENSOES = { ".mp4": "mp4", ".m4v": "mp4", ".mov": "mov" };

// ffprobe de verdade. ENOENT (não instalado) → null. Falha ao ler o arquivo
// → objeto com `erro` (quem chama só avisa).
export function ffprobePadrao(arquivo) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", arquivo],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
  );
  if (r.error?.code === "ENOENT") return null;
  if (r.error || r.status !== 0) return { erro: (r.stderr || r.error?.message || `saída ${r.status}`).trim().slice(0, 300) };
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { erro: "saída do ffprobe não é JSON" };
  }
}

// Lê só o começo do arquivo (nunca o vídeo inteiro).
function lerCabecalho(arquivo, n = 32) {
  const fd = openSync(arquivo, "r");
  try {
    const buf = Buffer.alloc(n);
    const lidos = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, lidos);
  } finally {
    closeSync(fd);
  }
}

// ISO BMFF (MP4/MOV): bytes 4..8 = "ftyp"; major brand "qt  " = QuickTime.
export function assinaturaVideo(bytes) {
  if (bytes.length < 12 || bytes.toString("latin1", 4, 8) !== "ftyp") return null;
  const marca = bytes.toString("latin1", 8, 12);
  return { container: marca === "qt  " ? "mov" : "mp4", marca: marca.trim() };
}

const fracao = (s) => {
  const [a, b] = String(s ?? "").split("/").map(Number);
  if (!Number.isFinite(a) || !a) return null;
  return b ? a / b : a;
};
const numero = (v) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// Resume o JSON do ffprobe no que interessa.
export function resumirFfprobe(info) {
  const streams = Array.isArray(info?.streams) ? info.streams : [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  let largura = numero(v?.width);
  let altura = numero(v?.height);
  // Vídeo de celular gravado em pé costuma vir 1920x1080 com rotação 90.
  const rotacao = numero(v?.tags?.rotate) ?? numero(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation) ?? 0;
  if (Math.abs(rotacao) % 180 === 90) [largura, altura] = [altura, largura];
  return {
    formato: String(info?.format?.format_name ?? ""),
    duracaoS: numero(info?.format?.duration) ?? numero(v?.duration),
    video: v
      ? { codec: v.codec_name, largura, altura, fps: fracao(v.avg_frame_rate) ?? fracao(v.r_frame_rate), bps: numero(v.bit_rate) }
      : null,
    audio: a ? { codec: a.codec_name, bps: numero(a.bit_rate) } : null,
  };
}

const fmtS = (s) => (s >= 60 ? `${Math.floor(s / 60)}min${String(Math.round(s % 60)).padStart(2, "0")}s` : `${s.toFixed(1)}s`);
const fmtMB = (n) => `${(n / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} MiB`;

// Valida o arquivo do Reels sem rede. Lança Error (limite duro) ou devolve
// { nome, tamanho, container, extensao, contentType, resumo, avisos, linhas }.
export function validarVideoReels(arquivo, { ffprobe = ffprobePadrao } = {}) {
  const nome = basename(arquivo);
  let st;
  try {
    st = statSync(arquivo);
  } catch {
    throw new Error(`Não consegui ler o arquivo ${arquivo}.`);
  }
  if (!st.isFile()) throw new Error(`Não consegui ler o arquivo ${arquivo} (não é um arquivo).`);

  const ext = extname(nome).toLowerCase();
  if (!EXTENSOES[ext]) {
    throw new Error(`${nome} não é MP4 (extensão ${ext || "ausente"}; esperado .mp4, ou .mov). Nada foi enviado.`);
  }
  const assinatura = assinaturaVideo(lerCabecalho(arquivo));
  if (!assinatura) {
    throw new Error(`${nome} não é MP4/MOV (não tem a assinatura ftyp no começo). Nada foi enviado.`);
  }

  const tamanho = st.size;
  if (tamanho > REELS_MAX_BYTES) {
    throw new Error(`${nome} tem ${fmtMB(tamanho)}; o limite do Instagram pra Reels é 300 MB. Nada foi enviado.`);
  }

  const avisos = [];
  const linhas = [`${nome}: ${fmtMB(tamanho)} (${tamanho} bytes), container ${assinatura.container} (ftyp ${assinatura.marca})`];
  const info = ffprobe(arquivo);
  let resumo = null;

  if (info === null || info === undefined) {
    avisos.push("aviso: ffprobe não encontrado no PATH; a duração (3s a 15min), o codec e a resolução NÃO foram conferidos. Seguindo mesmo assim.");
  } else if (info.erro) {
    avisos.push(`aviso: o ffprobe não conseguiu ler ${nome} (${info.erro}); duração e codec NÃO foram conferidos. Seguindo mesmo assim.`);
  } else {
    resumo = resumirFfprobe(info);
    const R = REELS_RECOMENDADO;

    // ── limites duros ──
    if (resumo.formato && !/(^|,)(mp4|mov)(,|$)/.test(resumo.formato)) {
      throw new Error(`${nome}: o ffprobe diz que o container é "${resumo.formato}", não MP4/MOV. Nada foi enviado.`);
    }
    if (!resumo.video) throw new Error(`${nome}: o ffprobe não achou faixa de vídeo. Nada foi enviado.`);
    if (resumo.duracaoS === null) {
      avisos.push(`aviso: o ffprobe não informou a duração de ${nome}; o limite de 3s a 15min NÃO foi conferido.`);
    } else if (resumo.duracaoS < REELS_MIN_DURACAO_S || resumo.duracaoS > REELS_MAX_DURACAO_S) {
      throw new Error(`${nome} tem ${fmtS(resumo.duracaoS)}; o Instagram aceita Reels de 3s a 15min. Nada foi enviado.`);
    }

    // ── recomendações (só avisa) ──
    const { codec, largura, altura, fps, bps } = resumo.video;
    linhas.push(
      `  ${resumo.duracaoS === null ? "duração ?" : fmtS(resumo.duracaoS)} · ${largura ?? "?"}x${altura ?? "?"} · ${fps ? `${Math.round(fps * 100) / 100} fps` : "fps ?"} · vídeo ${codec ?? "?"}${bps ? ` ${(bps / 1e6).toFixed(1)} Mbps` : ""} · áudio ${resumo.audio ? `${resumo.audio.codec ?? "?"}${resumo.audio.bps ? ` ${Math.round(resumo.audio.bps / 1000)} kbps` : ""}` : "nenhum"}`
    );
    if (largura && altura && Math.abs(largura / altura - 9 / 16) > 0.01) {
      avisos.push(`aviso: ${nome} tem ${largura}x${altura}; o recomendado pra Reels é 9:16 (${R.largura}x${R.altura}). O Instagram pode cortar ou pôr borda.`);
    }
    if (largura && largura > R.larguraMax) {
      avisos.push(`aviso: largura ${largura} passa de ${R.larguraMax}; o Instagram vai reduzir.`);
    }
    if (fps && (fps < R.fpsMin || fps > R.fpsMax)) {
      avisos.push(`aviso: ${Math.round(fps * 100) / 100} fps; o recomendado é de ${R.fpsMin} a ${R.fpsMax} fps.`);
    }
    if (codec && !R.videoCodecs.includes(codec)) {
      avisos.push(`aviso: codec de vídeo ${codec}; o recomendado é H.264 ou HEVC.`);
    }
    if (bps && bps > R.videoMaxBps) {
      avisos.push(`aviso: vídeo a ${(bps / 1e6).toFixed(1)} Mbps; o recomendado é até 25 Mbps.`);
    }
    if (resumo.audio?.codec && !R.audioCodecs.includes(resumo.audio.codec)) {
      avisos.push(`aviso: codec de áudio ${resumo.audio.codec}; o recomendado é AAC.`);
    }
    if (resumo.audio?.bps && resumo.audio.bps > R.audioMaxBps) {
      avisos.push(`aviso: áudio a ${Math.round(resumo.audio.bps / 1000)} kbps; o recomendado é até 128 kbps.`);
    }
  }

  const container = EXTENSOES[ext];
  return {
    nome,
    tamanho,
    container,
    extensao: container === "mov" ? "mov" : "mp4",
    contentType: container === "mov" ? "video/quicktime" : "video/mp4",
    resumo,
    avisos,
    linhas,
  };
}
