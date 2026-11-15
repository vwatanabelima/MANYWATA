// Hospedagem temporária dos JPEGs no Supabase Storage (projeto eternizacards,
// bucket público instagram-temp). Quem baixa as imagens é o servidor do Meta,
// então elas precisam estar numa URL https pública só durante a publicação;
// depois o CLI apaga.
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

export function sanitizarSlug(texto) {
  const s = String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "carrossel";
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

function erroStorage(msg, cred, caminhos) {
  const e = new Error(sanitizar(msg, [cred.chave]));
  if (caminhos) e.caminhos = [...caminhos];
  return e;
}
