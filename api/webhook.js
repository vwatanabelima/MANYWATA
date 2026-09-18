import crypto from "node:crypto";
// contas atendidas + suas regras palavra-gatilho → ação (edite contas.js)
import { contaPorUserId, regraQueCasa, tokenDaConta } from "./contas.js";

// ── Config via env vars (set no painel da Vercel) ─────────────────────────
// VERIFY_TOKEN e APP_SECRET são do APP, valem pra todas as contas.
// O token de acesso é POR CONTA e vive em contas.js (campo tokenEnv).
const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN;   // string que VOCÊ inventou
const APP_SECRET   = process.env.IG_APP_SECRET;     // "Chave secreta do app" do Meta
const GRAPH = "https://graph.instagram.com/v21.0";

// Vercel: precisamos do corpo cru pra validar a assinatura do Meta.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  // ── 1. Handshake de verificação (GET) ──────────────────────────────────
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge); // devolve o challenge puro
    }
    return res.status(403).send("Forbidden");
  }

  // ── 2. Eventos (POST) ───────────────────────────────────────────────────
  if (req.method === "POST") {
    const raw = await readRawBody(req);

    if (!verifySignature(raw, req.headers["x-hub-signature-256"])) {
      return res.status(401).send("Bad signature");
    }

    // IMPORTANTE: em serverless (Vercel) a função encerra ao enviar a resposta.
    // Então processamos ANTES de responder, senão o fetch do DM é cortado no meio.
    let payload;
    try { payload = JSON.parse(raw.toString("utf8")); }
    catch { return res.status(200).send("EVENT_RECEIVED"); }

    try { await processEvents(payload); }
    catch (err) { console.error("processEvents error:", err); }

    return res.status(200).send("EVENT_RECEIVED");
  }

  res.status(405).send("Method Not Allowed");
}

// ── Helpers ───────────────────────────────────────────────────────────────

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifySignature(raw, header) {
  if (!APP_SECRET) return true; // sem secret configurado, pula (NÃO use em produção)
  if (!header) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
  // timingSafeEqual exige buffers do mesmo tamanho
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function processEvents(payload) {
  if (payload.object !== "instagram") return;

  for (const entry of payload.entry || []) {
    // entry.id é o user_id da conta que RECEBEU o comentário.
    const conta = contaPorUserId(entry.id);
    if (!conta) {
      console.warn(`conta desconhecida no webhook: entry.id=${entry.id} — ignorado`);
      continue;
    }

    const token = tokenDaConta(conta);
    if (!token) {
      console.error(`${conta.slug}: env var ${conta.tokenEnv} não está setado na Vercel`);
      continue;
    }

    for (const change of entry.changes || []) {
      if (change.field !== "comments") continue;

      const c = change.value || {};
      const commentId = c.id;
      const fromId = c.from?.id;

      // não responde os próprios comentários
      if (fromId && entry.id && fromId === entry.id) continue;
      if (!commentId) continue;

      const rule = regraQueCasa(conta.regras, c.text);
      if (!rule) continue; // nenhuma palavra bateu → ignora

      console.log(`[${conta.slug}] comentário ${commentId} casou regra "${rule.keyword}"`);
      await sendPrivateReply(commentId, rule.dm, token);
      if (rule.publicReply) await replyToComment(commentId, rule.publicReply, token);
    }
  }
}

// DM privado — 1 por comentário, dentro de 7 dias
async function sendPrivateReply(commentId, text, token) {
  const r = await fetch(`${GRAPH}/me/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      recipient: { comment_id: commentId },
      message: { text },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) console.error("private reply falhou:", r.status, data);
  else console.log("DM enviado pro comentário", commentId);
}

// (opcional) resposta pública no próprio comentário
async function replyToComment(commentId, text, token) {
  const r = await fetch(`${GRAPH}/${commentId}/replies`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message: text }),
  });
  if (!r.ok) console.error("reply público falhou:", r.status, await r.text());
}
