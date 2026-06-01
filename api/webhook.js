import crypto from "node:crypto";

// ── Config via env vars (set no painel da Vercel) ─────────────────────────
const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN;   // string que VOCÊ inventou
const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;   // token long-lived da conta IG
const APP_SECRET   = process.env.IG_APP_SECRET;     // "Chave secreta do app" do Meta
const GRAPH = "https://graph.instagram.com/v21.0";

// Resposta automática. Edite o texto / palavra-gatilho como quiser.
const TRIGGER = (process.env.IG_TRIGGER_WORD || "").toLowerCase(); // vazio = responde todo comentário
const REPLY_TEXT = process.env.IG_REPLY_TEXT || "Oi! Vi seu comentário 🙌 te mandei o link aqui no direct.";

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

    // Responde 200 rápido — processa depois. Meta exige resposta < ~5s.
    res.status(200).send("EVENT_RECEIVED");

    let payload;
    try { payload = JSON.parse(raw.toString("utf8")); }
    catch { return; }

    try { await processEvents(payload); }
    catch (err) { console.error("processEvents error:", err); }
    return;
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
    for (const change of entry.changes || []) {
      if (change.field !== "comments") continue;

      const c = change.value || {};
      const commentId = c.id;
      const text = (c.text || "").toLowerCase();
      const fromId = c.from?.id;

      // não responde os próprios comentários
      if (fromId && entry.id && fromId === entry.id) continue;
      // filtro por palavra-gatilho (se configurado)
      if (TRIGGER && !text.includes(TRIGGER)) continue;
      if (!commentId) continue;

      await sendPrivateReply(commentId);
      // (opcional) responder publicamente também:
      // await replyToComment(commentId, "Te chamei no direct! 📩");
    }
  }
}

// DM privado — 1 por comentário, dentro de 7 dias
async function sendPrivateReply(commentId) {
  const r = await fetch(`${GRAPH}/me/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      recipient: { comment_id: commentId },
      message: { text: REPLY_TEXT },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) console.error("private reply falhou:", r.status, data);
  else console.log("DM enviado pro comentário", commentId);
}

// (opcional) resposta pública no próprio comentário
async function replyToComment(commentId, text) {
  const r = await fetch(`${GRAPH}/${commentId}/replies`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ message: text }),
  });
  if (!r.ok) console.error("reply público falhou:", r.status, await r.text());
}
