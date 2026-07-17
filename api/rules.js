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
    dm: "Bem-vindo à Quebra 🔥 Tô montando o Lab, comunidade onde ensino a vender com IA. O agente de WhatsApp que eu vendia por R$49,90 vai dentro, de graça. 20 vagas founder, R$97 único. Entra na waitlist e garante teu lugar: https://www.iadequebrada.com.br/comunidade#waitlist",
    publicReply: "Te mandei o link da waitlist no direct! 📩",
  },
  {
    // Pivô 2026-07-17: Watagent não é mais vendido separado. Posts antigos com
    // "comenta AGENTE" continuam gerando comentário — essa regra redireciona
    // pro Lab em vez de mandar o lead pro checkout que não existe mais.
    keyword: "agente",
    dm: "Salve! Aquele agente que eu vendia por R$49,90 não tá mais à venda: virou módulo do Lab IA de Quebra, a comunidade que tô montando. Quem entrar leva o agente de graça, junto com tudo que ensino sobre vender com IA. R$97 único, 20 vagas founder. Entra na waitlist que te aviso na abertura: https://www.iadequebrada.com.br/comunidade#waitlist",
    publicReply: "Te chamei no direct! 🤖📩",
  },
  {
    keyword: "setup",
    dm: "Salve! Vi que cê quer o Setup 🚀 É o kit inicial pra montar teu esquema com IA do zero, sem enrolação. Tudo que cê precisa pra começar hoje tá aqui: https://www.iadequebrada.com.br/setup-r0. Qualquer dúvida me chama nesse direct mesmo.",
    publicReply: "Te chamei no direct! 🚀📩",
  },
  {
    keyword: "quero",
    dm: "Salve! Vi que cê quer entrar 🚀 O Setup é o kit inicial pra montar teu esquema com IA do zero — tudo pra cê começar hoje. Olha aqui: https://www.iadequebrada.com.br/setup-r0. Qualquer dúvida me chama nesse direct mesmo.",
    publicReply: "Te chamei no direct! 🚀📩",
  },
];
