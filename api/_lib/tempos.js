// Tempos da publicação de mídia, num lugar só. Eles dependem uns dos outros:
//
//   CLI_TIMEOUT_ROTA_MS (330s)   o CLI espera a rota um pouco MAIS que o
//        >                       limite da função, senão desiste antes da
//                                resposta (e o resultado vira "indefinido")
//   MAX_DURATION_S (300s)        maxDuration de api/midia/*.js e
//        >                       api/carrossel/*.js no vercel.json (plano
//                                Hobby com Fluid Compute permite até 300s).
//                                Tem teste conferindo que o vercel.json bate.
//   ORCAMENTO_CONTAINERS_MS      quanto a rota gasta criando e esperando os
//     (240s) + folga (60s)       containers. A folga cobre o que vem depois
//                                do orçamento: a espera mínima do último
//                                aguardarStatus (STATUS_ESPERA_MINIMA_MS,
//                                pode acontecer duas vezes: filhos e
//                                carrossel), criar o container CAROUSEL,
//                                media_publish, permalink e a resposta.
//
// Mudou o maxDuration? Mude MAX_DURATION_S, o vercel.json e o orçamento
// juntos (o teste "tempos" em tests/midia.test.js reclama se não baterem).

export const MAX_DURATION_S = 300;
export const ORCAMENTO_CONTAINERS_MS = 240_000;

// Reels tem UM container só (sem filhos, sem CAROUSEL depois), então pode
// usar mais do orçamento: 270s, deixando 30s pra media_publish, permalink e
// resposta. Mesmo assim vídeo longo pode levar mais que isso pra ficar
// FINISHED e a rota responde 504 (nada publicado). Dividir em duas chamadas
// (cria / checa e publica) é outro desenho, fora daqui.
export const ORCAMENTO_REELS_MS = 270_000;

// aguardarStatus: mesmo com orçamento estourado (ou <= 0), checa de verdade
// e espera pelo menos isto antes de desistir. Evita o 504 "em 0s" de quando
// a criação dos containers comia o orçamento todo.
export const STATUS_ESPERA_MINIMA_MS = 10_000;
export const STATUS_CHECAGENS_MINIMAS = 3;

// Polling do status_code: começa em 2s e cresce (x1,5) até 5s.
export const STATUS_INTERVALO_INICIAL_MS = 2_000;
export const STATUS_INTERVALO_MAX_MS = 5_000;

// Timeout do fetch do CLI pra rota. Tem que ser > MAX_DURATION_S.
export const CLI_TIMEOUT_ROTA_MS = 330_000;
