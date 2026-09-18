// Cadastro das contas do Instagram atendidas por este webhook.
//
// Um app do Meta, uma Callback URL, várias contas. O Meta manda o user_id da
// conta que recebeu o comentário em `entry.id` do payload — é por ele que a
// gente descobre de quem é o comentário e qual token usar pra responder.
//
// Pra adicionar uma conta:
//   1. autorizar a conta no MESMO app do Meta (Instagram > Configuração da API)
//   2. pegar o user_id:  GET me?fields=user_id,username&access_token=...
//   3. assinar o webhook: POST <user_id>/subscribed_apps?subscribed_fields=comments,messages
//   4. setar o token num env var novo na Vercel (tipo Encrypted, NUNCA Sensitive)
//   5. adicionar a entrada aqui e dar push
//
// ⚠️ user_id NÃO é o mesmo que `id`. O `id` é app-scoped e não casa com
// entry.id — usar o errado faz o webhook ignorar todo comentário, em silêncio.

export const CONTAS = [
  {
    slug: "watanabe",
    username: "watanabe.ia",
    userId: "17841400866194604",
    tokenEnv: "IG_ACCESS_TOKEN",
    // Desligado em 2026-09-17. As regras antigas (quebra/agente/setup/quero)
    // mandavam pra waitlist de uma comunidade que não existe mais. Religar
    // exige copy nova, não é só descomentar.
    regras: [],
  },
  {
    slug: "eterniza",
    username: "eternizacards",
    userId: "17841438494434121",
    tokenEnv: "IG_ACCESS_TOKEN_ETERNIZA",
    regras: [
      {
        keyword: "quero",
        // Público é colecionador de TCG, não quebrada. Mede em mm, já tem
        // sleeve em casa e não quer carta ruim impressa — daí 63x88 e o OK
        // antes da impressão. "48h ÚTEIS": sem o "úteis" vira promessa errada.
        dm: "Oi! Vi seu comentário. Você manda a foto, nosso ilustrador desenha no estilo de carta de jogo (com nome e ataque da pessoa) e a gente imprime em papel holográfico, 63x88mm, o tamanho oficial. Cabe em sleeve e toploader normal. A arte chega no seu WhatsApp em até 48h úteis e só vai pra impressão depois do seu OK. Modelos e preços: https://eternizacards.com.br/?utm_source=instagram&utm_medium=dm&utm_campaign=comentario&utm_content=quero",
        publicReply: "Te chamei no direct! 📩",
      },
    ],
  },
];

export function contaPorUserId(userId) {
  if (!userId) return undefined;
  return CONTAS.find((c) => c.userId === String(userId));
}

export function contaPorSlug(slug) {
  return CONTAS.find((c) => c.slug === slug);
}

// Primeira regra cuja palavra-gatilho está contida no comentário.
// A ORDEM importa: ponha a mais específica antes da mais genérica.
export function regraQueCasa(regras, texto) {
  if (!texto) return undefined;
  const t = String(texto).toLowerCase();
  return (regras || []).find((r) => t.includes(r.keyword.toLowerCase()));
}

export function tokenDaConta(conta, env = process.env) {
  return env[conta.tokenEnv];
}
