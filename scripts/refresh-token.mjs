// Renova o token long-lived do Instagram e grava o novo valor no env var
// IG_ACCESS_TOKEN da Vercel, depois dispara um redeploy.
//
// Roda no GitHub Actions (cron). Secrets necessários no repo:
//   VERCEL_TOKEN        token de API da Vercel
//   VERCEL_PROJECT_ID   id do projeto manywata
//   VERCEL_TEAM_ID      (opcional) só se a conta for de time/Team
//   VERCEL_DEPLOY_HOOK  URL do Deploy Hook da Vercel (dispara o redeploy)

const {
  VERCEL_TOKEN,
  VERCEL_PROJECT_ID,
  VERCEL_TEAM_ID,
  VERCEL_DEPLOY_HOOK,
} = process.env;

const ENV_KEY = "IG_ACCESS_TOKEN";
const team = VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : "";
const teamAmp = VERCEL_TEAM_ID ? `&teamId=${VERCEL_TEAM_ID}` : "";
const vHeaders = { Authorization: `Bearer ${VERCEL_TOKEN}` };

function die(msg) { console.error("ERRO:", msg); process.exit(1); }

if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) {
  die("faltam VERCEL_TOKEN e/ou VERCEL_PROJECT_ID nos secrets.");
}

// 1. Acha o env var IG_ACCESS_TOKEN e lê o valor atual (decifrado)
const listRes = await fetch(
  `https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/env${team}`,
  { headers: vHeaders }
);
const list = await listRes.json();
if (!listRes.ok) die(`listar env falhou: ${JSON.stringify(list)}`);

const envVar = (list.envs || list).find?.((e) => e.key === ENV_KEY)
  || (list.envs || []).find((e) => e.key === ENV_KEY);
if (!envVar) die(`env var ${ENV_KEY} não encontrado no projeto.`);

const getRes = await fetch(
  `https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/env/${envVar.id}?decrypt=true${teamAmp}`,
  { headers: vHeaders }
);
const cur = await getRes.json();
if (!getRes.ok) die(`ler valor do env falhou: ${JSON.stringify(cur)}`);

const currentToken = cur.value;
if (!currentToken || currentToken.length < 50) {
  die(`token atual inválido/ilegível. Confira se ${ENV_KEY} é tipo "Encrypted" (não "Sensitive") na Vercel.`);
}

// 2. Renova na Meta (estende +60 dias)
const refRes = await fetch(
  `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${currentToken}`
);
const ref = await refRes.json();
if (!refRes.ok || !ref.access_token) die(`refresh falhou: ${JSON.stringify(ref)}`);

const newToken = ref.access_token;
const days = Math.round((ref.expires_in || 0) / 86400);
console.log(`token renovado, expira em ~${days} dias.`);

// 3. Grava o token novo na Vercel (se mudou)
if (newToken !== currentToken) {
  const patchRes = await fetch(
    `https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/env/${envVar.id}${team}`,
    {
      method: "PATCH",
      headers: { ...vHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ value: newToken }),
    }
  );
  const patch = await patchRes.json();
  if (!patchRes.ok) die(`atualizar env falhou: ${JSON.stringify(patch)}`);
  console.log("env IG_ACCESS_TOKEN atualizado na Vercel.");

  // 4. Redeploy pra aplicar o env novo
  if (VERCEL_DEPLOY_HOOK) {
    const hookRes = await fetch(VERCEL_DEPLOY_HOOK, { method: "POST" });
    console.log(`deploy hook disparado: HTTP ${hookRes.status}`);
  } else {
    console.log("AVISO: sem VERCEL_DEPLOY_HOOK — redeploy não disparado. Faça manual ou configure o hook.");
  }
} else {
  console.log("token não mudou (Meta só estendeu validade). Nada a atualizar.");
}

console.log("ok.");
