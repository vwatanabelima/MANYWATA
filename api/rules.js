// Regras de automação: palavra-gatilho → ação (DM + resposta pública).
// Edite aqui e dê `git push` — a Vercel redeploya sozinha.
//
// - keyword: palavra que dispara (comparada em minúsculas, casa se ESTIVER contida no comentário)
// - dm: texto da mensagem direta enviada ao autor
// - publicReply: (opcional) resposta pública no próprio comentário; "" = não responde publicamente
//
// A primeira regra que casar é aplicada (ordene da mais específica pra mais genérica).

export const RULES = [
  {
    keyword: "quebra",
    dm: "Bem-vindo à Quebra 🔥 entra na nossa waitlist e garante o acesso antecipado: https://SUA-WAITLIST-AQUI",
    publicReply: "Te mandei o link da waitlist no direct! 📩",
  },
  {
    keyword: "quero",
    dm: "Oi! Vi seu comentário 🙌 te mandei o link aqui no direct.",
    publicReply: "Te chamei no direct! 📩",
  },
];
