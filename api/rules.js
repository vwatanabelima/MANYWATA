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
    dm: "Bem-vindo à Quebra 🔥 entra na nossa waitlist e garante o acesso antecipado: https://www.iadequebrada.com.br/comunidade#waitlist",
    publicReply: "Te mandei o link da waitlist no direct! 📩",
  },
  {
    keyword: "agente",
    dm: "Salve! Vi que cê quer o agente 🤖 Ele fica no teu WhatsApp e Insta respondendo cliente sozinho, 24h. R$49,90 e é teu — usa no teu corre ou revende pra outros comércios. Olha como funciona aqui: https://www.iadequebrada.com.br/agente-whatsapp. Qualquer dúvida me chama nesse direct mesmo.",
    publicReply: "Te chamei no direct! 🤖📩",
  },
  {
    keyword: "setup",
    dm: "Oi! Vi seu comentário 🙌 te mandei o link aqui no direct.",
    publicReply: "Te chamei no direct! 📩",
  },
  {
    keyword: "quero",
    dm: "Oi! Vi seu comentário 🙌 te mandei o link aqui no direct.",
    publicReply: "Te chamei no direct! 📩",
  },
];
