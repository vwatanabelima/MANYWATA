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
    // Ordem importa (vale a primeira que casar): as específicas antes do
    // "quero", que é o genérico. Keywords sem acento — regraQueCasa normaliza.
    // DM do Instagram tem limite de 1000 bytes UTF-8 (há teste pra isso).
    regras: [
      {
        keyword: "trio",
        dm: "Oi! Vi seu comentário. Você manda a foto e o nome, a gente desenha no estilo de carta de jogo e imprime em papel holográfico, 63x88mm, o tamanho oficial, que cabe em sleeve e toploader. O Trio são 3 cartas por R$ 99,90 com frete grátis, e você escolhe quem entra em cada uma. A arte fica pronta em até 3 dias úteis depois que a foto e o nome chegam, e a produção leva 4 dias úteis depois que você aprova a arte. Modelos e preços: https://eternizacards.com.br/?utm_source=instagram&utm_medium=dm&utm_campaign=comentario&utm_content=trio",
        publicReply: "Te chamei no direct! 📩",
      },
      {
        keyword: "unica",
        // A Única NÃO tem frete grátis — só o Trio. Não prometer.
        dm: "Oi! Vi seu comentário. Você manda a foto e o nome, a gente desenha no estilo de carta de jogo e imprime em papel holográfico, 63x88mm, o tamanho oficial, que cabe em sleeve e toploader. A Carta Única sai por R$ 39,90. A arte fica pronta em até 3 dias úteis depois que a foto e o nome chegam, e a produção leva 4 dias úteis depois que você aprova a arte. Modelos e preços: https://eternizacards.com.br/?utm_source=instagram&utm_medium=dm&utm_campaign=comentario&utm_content=unica",
        publicReply: "Te chamei no direct! 📩",
      },
      {
        keyword: "modelos",
        dm: "Oi! Vi seu comentário. Você manda a foto e o nome, a gente desenha no estilo de carta de jogo e imprime em papel holográfico, 63x88mm, o tamanho oficial, que cabe em sleeve e toploader. Tem duas opções. A Carta Única sai por R$ 39,90. O Trio são 3 cartas por R$ 99,90 com frete grátis, e você escolhe quem entra em cada uma. A arte fica pronta em até 3 dias úteis depois que a foto e o nome chegam, e a produção leva 4 dias úteis depois que você aprova a arte. Modelos e preços: https://eternizacards.com.br/?utm_source=instagram&utm_medium=dm&utm_campaign=comentario&utm_content=modelos",
        publicReply: "Te chamei no direct! 📩",
      },
      {
        keyword: "quero",
        // Público é colecionador de TCG. Mede em mm e já tem sleeve em casa —
        // daí 63x88. Prazos sempre em dias ÚTEIS: sem o "úteis" vira promessa
        // errada. Texto fixo, aprovado como está: não reescrever.
        dm: "Oi! Vi seu comentário. Você manda a foto e o nome, a gente desenha no estilo de carta de jogo e imprime em papel holográfico, 63x88mm, o tamanho oficial, que cabe em sleeve e toploader. A Carta Única sai por R$ 39,90. O Trio são 3 cartas por R$ 99,90 com frete grátis, e você escolhe quem entra em cada uma. A arte fica pronta em até 3 dias úteis depois que a foto e o nome chegam, e a produção leva 4 dias úteis depois que você aprova a arte. Modelos e preços: https://eternizacards.com.br/?utm_source=instagram&utm_medium=dm&utm_campaign=comentario&utm_content=quero",
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

// Minúsculas e sem acento (NFD + remove marcas diacríticas): "Única" → "unica".
function normalizar(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Primeira regra cuja palavra-gatilho está contida no comentário (substring,
// não palavra inteira), ignorando maiúsculas e acentos dos dois lados.
// A ORDEM importa: ponha a mais específica antes da mais genérica.
export function regraQueCasa(regras, texto) {
  if (!texto) return undefined;
  const t = normalizar(texto);
  return (regras || []).find((r) => t.includes(normalizar(r.keyword)));
}

export function tokenDaConta(conta, env = process.env) {
  return env[conta.tokenEnv];
}
