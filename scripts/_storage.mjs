// Hospedagem temporária dos JPEGs no Supabase Storage (projeto eternizacards,
// bucket público instagram-temp). Quem baixa as imagens é o servidor do Meta,
// então elas precisam estar numa URL https pública só durante a publicação;
// depois o CLI apaga (quando o resultado é definido; ver scripts/midia.mjs).
//
// Credenciais SÓ do ambiente (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY), que o
// operador carrega de um arquivo protegido:
//   set -a; . /home/box/.secrets/supabase-eterniza.env; set +a
// Nunca de argv, nunca do .env.local, nunca impressas. Todo texto de erro
// passa por sanitizar() com a chave.
//
// Tudo aqui recebe fetch injetado (testes nunca chamam a rede).

import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { sanitizar } from "../api/_lib/seguranca.js";

export const BUCKET = "instagram-temp";
export const MAX_BYTES = 8 * 1024 * 1024; // limite do bucket

// ── Credenciais ───────────────────────────────────────────────────────────

// Lê do ambiente e falha claro, sem ecoar valor nenhum.
export function lerCredenciaisStorage(env = process.env) {
  const faltando = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((n) => !String(env[n] ?? "").trim());
  if (faltando.length) {
    throw new Error(
      [
        `Falta ${faltando.join(" e ")} no ambiente (necessário pra subir os JPEGs no Supabase Storage).`,
        "Carregue do arquivo protegido antes de rodar:",
        "  set -a; . /home/box/.secrets/supabase-eterniza.env; set +a",
        "Ou passe --base-url se as imagens já estão numa URL pública.",
      ].join("\n")
    );
  }
  const chave = String(env.SUPABASE_SERVICE_ROLE_KEY).trim();
  let u;
  try {
    u = new URL(String(env.SUPABASE_URL).trim());
  } catch {
    throw new Error("SUPABASE_URL inválida (esperado https://<projeto>.supabase.co).");
  }
  if (u.protocol !== "https:" || u.username || u.password) {
    throw new Error("SUPABASE_URL inválida (esperado https://<projeto>.supabase.co).");
  }
  return { url: u.origin, chave };
}

// ── Nomes ─────────────────────────────────────────────────────────────────

export function sanitizarSlug(texto, padrao = "carrossel") {
  const s = String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || padrao;
}

// carrossel/drop-natal/render → "drop-natal"; pasta com outro nome → o próprio nome.
export function slugDaPasta(pasta) {
  const abs = resolve(pasta);
  const nome = basename(abs);
  return sanitizarSlug(nome.toLowerCase() === "render" ? basename(dirname(abs)) : nome);
}

// 20261115-0105 (UTC) + sufixo aleatório curto, pra duas rodadas no mesmo
// minuto não colidirem (o upload usa x-upsert: false).
export function carimbo(agora = new Date(), sufixo = randomBytes(3).toString("hex")) {
  const p = (n) => String(n).padStart(2, "0");
  const data = `${agora.getUTCFullYear()}${p(agora.getUTCMonth() + 1)}${p(agora.getUTCDate())}`;
  return `${data}-${p(agora.getUTCHours())}${p(agora.getUTCMinutes())}-${sufixo}`;
}

export function montarCaminhos(prefixo, slides) {
  return slides.map((nome) => `${prefixo}/${nome}`);
}

export function urlPublica(baseSupabase, caminho) {
  return `${baseSupabase}/storage/v1/object/public/${BUCKET}/${codificar(caminho)}`;
}

function codificar(caminho) {
  return caminho.split("/").map(encodeURIComponent).join("/");
}

// ── Validação local (antes de qualquer upload) ────────────────────────────

const ehJpeg = (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

// Confere tamanho e assinatura JPEG de cada slide e devolve os bytes.
export function lerSlidesJpeg(pasta, slides) {
  return slides.map((nome) => {
    const arquivo = join(pasta, nome);
    const { size } = statSync(arquivo);
    if (size > MAX_BYTES) {
      throw new Error(`${nome} tem ${(size / 1024 / 1024).toFixed(1)} MB; o limite do bucket é 8 MB. Nada foi enviado.`);
    }
    const bytes = readFileSync(arquivo);
    if (!ehJpeg(bytes)) throw new Error(`${nome} não é JPEG (não começa com FF D8 FF). Nada foi enviado.`);
    return { nome, bytes };
  });
}

// Largura x altura lidas do cabeçalho do JPEG (segmento SOFn), sem
// dependência. Devolve null se não achar (arquivo truncado/estranho): quem
// chama só avisa, nunca bloqueia. Não aplica a rotação do EXIF: uma foto de
// celular "em pé" pode aparecer aqui como 1920x1080.
export function dimensoesJpeg(bytes) {
  if (!ehJpeg(bytes)) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marcador = bytes[i + 1];
    if (marcador === 0xff) {
      i++; // byte de preenchimento
      continue;
    }
    // marcadores sem tamanho: TEM, RSTn, SOI, EOI
    if (marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd9)) {
      if (marcador === 0xd9) return null;
      i += 2;
      continue;
    }
    const tamanho = (bytes[i + 2] << 8) | bytes[i + 3];
    if (tamanho < 2) return null;
    // SOF0..SOF15, menos DHT (C4), JPG (C8) e DAC (CC)
    const ehSof = marcador >= 0xc0 && marcador <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marcador);
    if (ehSof) {
      if (i + 8 >= bytes.length) return null;
      const altura = (bytes[i + 5] << 8) | bytes[i + 6];
      const largura = (bytes[i + 7] << 8) | bytes[i + 8];
      return largura && altura ? { largura, altura } : null;
    }
    if (marcador === 0xda) return null; // começou a imagem e não achou SOF
    i += 2 + tamanho;
  }
  return null;
}

// ── Storage REST ──────────────────────────────────────────────────────────

const headers = (chave, contentType) => ({
  Authorization: `Bearer ${chave}`,
  apikey: chave,
  "Content-Type": contentType,
});

async function detalhe(r) {
  const corpo = await r.json().catch(() => ({}));
  return corpo.message || corpo.error || "sem detalhe";
}

// Sobe na ordem, um por vez. Se falhar no meio, o erro carrega em .caminhos
// tudo o que foi tentado (inclusive o que falhou: pode ter chegado ao
// servidor), pra quem chamou apagar.
export async function enviarParaStorage({ arquivos, prefixo, cred, fetch = globalThis.fetch }) {
  const caminhos = [];
  for (const { nome, bytes } of arquivos) {
    const caminho = `${prefixo}/${nome}`;
    caminhos.push(caminho);
    let r;
    try {
      r = await fetch(`${cred.url}/storage/v1/object/${BUCKET}/${codificar(caminho)}`, {
        method: "POST",
        headers: { ...headers(cred.chave, "image/jpeg"), "x-upsert": "false" },
        body: bytes,
      });
    } catch (e) {
      throw erroStorage(`Falha de rede subindo ${nome} pro Storage: ${e?.message}`, cred, caminhos);
    }
    if (!r.ok) {
      throw erroStorage(`Storage recusou ${nome} (HTTP ${r.status}): ${await detalhe(r)}`, cred, caminhos);
    }
  }
  return { caminhos, urls: caminhos.map((c) => urlPublica(cred.url, c)) };
}

export async function apagarDoStorage({ caminhos, cred, fetch = globalThis.fetch }) {
  if (!caminhos.length) return;
  let r;
  try {
    r = await fetch(`${cred.url}/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      headers: headers(cred.chave, "application/json"),
      body: JSON.stringify({ prefixes: caminhos }),
    });
  } catch (e) {
    throw erroStorage(`Falha de rede apagando do Storage: ${e?.message}`, cred);
  }
  if (!r.ok) throw erroStorage(`Storage recusou apagar (HTTP ${r.status}): ${await detalhe(r)}`, cred);
}

// Prefixo que o CLI cria: <slug>-<AAAAMMDD-HHMM>-<aleatório>, só [a-z0-9-].
// Aceita também "instagram-temp/<prefixo>/" (do jeito que o CLI imprime).
// Recusa barra no meio, "..", vazio: o limpar nunca sai de UMA pasta.
export function normalizarPrefixo(valor) {
  let p = String(valor ?? "").trim();
  if (p.startsWith(`${BUCKET}/`)) p = p.slice(BUCKET.length + 1);
  p = p.replace(/\/+$/, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(p)) {
    throw new Error(`prefixo inválido: "${valor ?? ""}". Esperado algo como drop-natal-20261115-0105-a1b2c3 (só a-z, 0-9 e -).`);
  }
  return p;
}

// Lista os arquivos de UMA pasta do bucket (POST /object/list/<bucket>).
// O Storage devolve nomes relativos à pasta; subpasta vem com id null e fica
// de fora (o CLI nunca cria subpasta). Devolve os caminhos completos.
export async function listarDoStorage({ prefixo, cred, fetch = globalThis.fetch }) {
  const caminhos = [];
  const lote = 1000;
  for (let offset = 0; ; offset += lote) {
    let r;
    try {
      r = await fetch(`${cred.url}/storage/v1/object/list/${BUCKET}`, {
        method: "POST",
        headers: headers(cred.chave, "application/json"),
        body: JSON.stringify({ prefix: prefixo, limit: lote, offset, sortBy: { column: "name", order: "asc" } }),
      });
    } catch (e) {
      throw erroStorage(`Falha de rede listando ${BUCKET}/${prefixo}/: ${e?.message}`, cred);
    }
    if (!r.ok) throw erroStorage(`Storage recusou listar ${BUCKET}/${prefixo}/ (HTTP ${r.status}): ${await detalhe(r)}`, cred);
    const itens = await r.json().catch(() => null);
    if (!Array.isArray(itens)) throw erroStorage(`Storage devolveu uma listagem inválida pra ${BUCKET}/${prefixo}/.`, cred);
    for (const item of itens) {
      if (item?.id && typeof item.name === "string" && item.name) caminhos.push(`${prefixo}/${item.name}`);
    }
    if (itens.length < lote) return caminhos;
  }
}

function erroStorage(msg, cred, caminhos) {
  const e = new Error(sanitizar(msg, [cred.chave]));
  if (caminhos) e.caminhos = [...caminhos];
  return e;
}
