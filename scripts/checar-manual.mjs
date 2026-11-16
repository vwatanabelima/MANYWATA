#!/usr/bin/env node
// Confere se a cópia do manual (docs/agente-whatsapp-manual.md) bate com
// docs/agente-whatsapp-manual.md da main do eternizacards-painel.
//
//   npm run checar-manual                 # 0 = em dia, 1 = diverge, 2 = erro
//   npm run checar-manual -- --atualizar  # regrava a cópia + cabeçalho (commit e sha256)
//
// O painel é repo PRIVADO: busca com o `gh` já logado do operador
// (gh api repos/.../contents/...?ref=main). Sem `gh` (ou se ele falhar) e com
// GITHUB_TOKEN no ambiente, tenta a API do GitHub com esse token. Não roda
// no build da Vercel nem em teste (fala com a rede): é do terminal do operador.
//
// Depois de --atualizar: confira as travas de api/_lib/dm-regras.js (preços,
// prazos, Black Friday) e rode npm test.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { CAMINHO_MANUAL_PAINEL, REPO_PAINEL, montarManual, separarManual, sha256 } from "../api/_lib/dm-llm.js";
import { sanitizar } from "../api/_lib/seguranca.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CAMINHO_COPIA = join(ROOT, "docs", "agente-whatsapp-manual.md");

const CONTEUDO = `repos/${REPO_PAINEL}/contents/${CAMINHO_MANUAL_PAINEL}?ref=main`;
const COMMITS = `repos/${REPO_PAINEL}/commits?path=${encodeURIComponent(CAMINHO_MANUAL_PAINEL)}&sha=main&per_page=1`;

function lerConteudo(j) {
  if (!j || typeof j.content !== "string") throw new Error("resposta da API sem 'content'");
  return Buffer.from(j.content.replace(/\s+/g, ""), j.encoding || "base64").toString("utf8");
}

function lerCommit(lista) {
  const c = Array.isArray(lista) ? lista[0] : null;
  if (!c?.sha) return null;
  return {
    sha: String(c.sha),
    data: c.commit?.committer?.date || c.commit?.author?.date || "",
    mensagem: String(c.commit?.message || "").split("\n")[0].slice(0, 120),
  };
}

// { conteudo, commit: { sha, data, mensagem } | null }
export async function buscarDoPainel({ env = process.env, exec = execFileSync, fetch: fetchFn = globalThis.fetch } = {}) {
  const gh = (caminho) => JSON.parse(exec("gh", ["api", caminho], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }));
  let erroGh;
  try {
    return { conteudo: lerConteudo(gh(CONTEUDO)), commit: lerCommit(gh(COMMITS)) };
  } catch (err) {
    erroGh = err;
  }
  const token = String(env.GITHUB_TOKEN ?? "").trim();
  const motivoGh = erroGh?.code === "ENOENT" ? "gh não instalado" : `gh falhou: ${String(erroGh?.stderr || erroGh?.message || erroGh).trim().slice(0, 200)}`;
  if (!token) throw new Error(`${motivoGh} (e sem GITHUB_TOKEN). Rode \`gh auth login\` e tente de novo.`);

  const api = async (caminho) => {
    const r = await fetchFn(`https://api.github.com/${caminho}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "manywata-checar-manual" },
      signal: AbortSignal.timeout(15_000),
    });
    const texto = await r.text();
    if (!r.ok) throw new Error(sanitizar(`GitHub ${r.status}: ${texto.slice(0, 200)}`, [token]));
    return JSON.parse(texto);
  };
  try {
    return { conteudo: lerConteudo(await api(CONTEUDO)), commit: lerCommit(await api(COMMITS)) };
  } catch (err) {
    throw new Error(sanitizar(`${motivoGh}; GITHUB_TOKEN também falhou: ${err?.message || err}`, [token]));
  }
}

// Devolve o código de saída. Tudo injetável pros testes (sem rede).
export async function executar({
  args = process.argv.slice(2),
  buscar = () => buscarDoPainel(),
  caminho = CAMINHO_COPIA,
  ler = (p) => readFileSync(p, "utf8"),
  gravar = (p, t) => writeFileSync(p, t),
  log = console.log,
  erro = console.error,
} = {}) {
  const atualizar = args.includes("--atualizar");
  try {
    const local = separarManual(ler(caminho));
    if (!local.cabecalho) erro("⚠️  a cópia está sem o cabeçalho (commit + sha256)");
    else if (local.sha256 !== sha256(local.conteudo)) erro("⚠️  a cópia foi editada à mão: o sha256 do conteúdo não bate com o do cabeçalho");

    const remoto = await buscar();
    const commit = remoto.commit;
    const descricao = commit ? `${commit.sha.slice(0, 7)} (${commit.data}) ${commit.mensagem}` : "commit desconhecido";

    if (sha256(remoto.conteudo) === sha256(local.conteudo)) {
      log(`✅ manual em dia com a main do painel (último commit do arquivo: ${descricao})`);
      if (atualizar && local.sha256 !== sha256(local.conteudo) && commit) {
        gravar(caminho, montarManual(remoto.conteudo, commit.sha.slice(0, 7)));
        log("   cabeçalho regravado");
      }
      return 0;
    }

    if (atualizar) {
      if (!commit) throw new Error("não deu pra ler o commit do arquivo no painel; não regravei");
      gravar(caminho, montarManual(remoto.conteudo, commit.sha.slice(0, 7)));
      log(`✍️  cópia regravada com a main do painel @ ${descricao}`);
      log("   Agora confira as travas de api/_lib/dm-regras.js (preços, prazos, Black Friday) e rode npm test.");
      return 0;
    }

    erro(`❌ manual DIVERGE da main do painel.`);
    erro(`   cópia: @ ${local.commit ?? "?"} (sha256 ${sha256(local.conteudo).slice(0, 12)}…)`);
    erro(`   painel: último commit do arquivo ${descricao} (sha256 ${sha256(remoto.conteudo).slice(0, 12)}…)`);
    erro("   Pra atualizar: npm run checar-manual -- --atualizar");
    return 1;
  } catch (err) {
    erro(`erro: ${err?.message || err}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await executar();
}
