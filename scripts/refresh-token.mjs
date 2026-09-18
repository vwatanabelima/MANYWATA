// Renova o token long-lived do Instagram de CADA conta cadastrada em
// api/contas.js e grava o novo valor no env var correspondente da Vercel
// (campo tokenEnv), depois dispara um redeploy se alguma coisa mudou.
//
// Roda no GitHub Actions (cron). Secrets necessários no repo:
//   VERCEL_TOKEN        token de API da Vercel
//   VERCEL_PROJECT_ID   id do projeto manywata
//   VERCEL_TEAM_ID      (opcional) só se a conta for de time/Team
//   VERCEL_DEPLOY_HOOK  URL do Deploy Hook da Vercel (dispara o redeploy)
//
// Conta nova não precisa de secret novo: o token vive na Vercel e o script
// descobre quais ler a partir de contas.js.

import { CONTAS } from "../api/contas.js";

const {
  VERCEL_TOKEN,
  VERCEL_PROJECT_ID,
  VERCEL_TEAM_ID,
  VERCEL_DEPLOY_HOOK,
} = process.env;

const team = VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : "";
const teamAmp = VERCEL_TEAM_ID ? `&teamId=${VERCEL_TEAM_ID}` : "";
const vHeaders = { Authorization: `Bearer ${VERCEL_TOKEN}` };

function die(msg) { console.error("ERRO:", msg); process.exit(1); }

if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) {
  die("faltam VERCEL_TOKEN e/ou VERCEL_PROJECT_ID nos secrets.");
}

// Lista os env vars do projeto uma vez só.
const listRes = await fetch(
  `https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/env${team}`,
  { headers: vHeaders }
);
const list = await listRes.json();
if (!listRes.ok) die(`listar env falhou: ${JSON.stringify(list)}`);
const envs = list.envs || list;

// Renova uma conta. Devolve true se o valor na Vercel mudou.
async function renovar(conta) {
  const chave = conta.tokenEnv;

  const envVar = envs.find((e) => e.key === chave);
  if (!envVar) throw new Error(`env var ${chave} não encontrado no projeto.`);

  const getRes = await fetch(
    `https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/env/${envVar.id}?decrypt=true${teamAmp}`,
    { headers: vHeaders }
  );
  const cur = await getRes.json();
  if (!getRes.ok) throw new Error(`ler valor do env falhou: ${JSON.stringify(cur)}`);

  const currentToken = cur.value;
  if (!currentToken || currentToken.length < 50) {
    throw new Error(`token atual inválido/ilegível. Confira se ${chave} é tipo "Encrypted" (não "Sensitive") na Vercel.`);
  }

  // Renova na Meta (estende +60 dias)
  const refRes = await fetch(
    `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${currentToken}`
  );
  const ref = await refRes.json();
  if (!refRes.ok || !ref.access_token) throw new Error(`refresh falhou: ${JSON.stringify(ref)}`);

  const newToken = ref.access_token;
  const days = Math.round((ref.expires_in || 0) / 86400);
  console.log(`[${conta.slug}] token renovado, expira em ~${days} dias.`);

  if (newToken === currentToken) {
    console.log(`[${conta.slug}] token não mudou (Meta só estendeu validade).`);
    return false;
  }

  const patchRes = await fetch(
    `https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/env/${envVar.id}${team}`,
    {
      method: "PATCH",
      headers: { ...vHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ value: newToken }),
    }
  );
  const patch = await patchRes.json();
  if (!patchRes.ok) throw new Error(`atualizar env falhou: ${JSON.stringify(patch)}`);
  console.log(`[${conta.slug}] env ${chave} atualizado na Vercel.`);
  return true;
}

// Uma conta com token morto não pode impedir a renovação das outras — senão
// um token vencido derruba todas as contas junto, uma por vez.
let mudouAlguma = false;
const falhas = [];
for (const conta of CONTAS) {
  try {
    if (await renovar(conta)) mudouAlguma = true;
  } catch (e) {
    falhas.push(`${conta.slug}: ${e.message}`);
    console.error(`[${conta.slug}] ERRO: ${e.message}`);
  }
}

// Redeploy uma vez só, no fim, se alguma coisa mudou.
if (mudouAlguma) {
  if (VERCEL_DEPLOY_HOOK) {
    const hookRes = await fetch(VERCEL_DEPLOY_HOOK, { method: "POST" });
    console.log(`deploy hook disparado: HTTP ${hookRes.status}`);
  } else {
    console.log("AVISO: sem VERCEL_DEPLOY_HOOK — redeploy não disparado. Faça manual ou configure o hook.");
  }
} else {
  console.log("nenhum token mudou. Redeploy não necessário.");
}

if (falhas.length) {
  console.error(`\n${falhas.length} conta(s) falharam:\n  ${falhas.join("\n  ")}`);
  process.exit(1);
}
console.log("ok.");
