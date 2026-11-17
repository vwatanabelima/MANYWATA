// Regras da resposta automática de DM que não dependem de banco nem de rede.
// Puro pra testar. Portado de lib/agente/zap/regras.ts do eternizacards-painel
// (montarTurno, contexto, horário do humano, janela de 24h), com as travas
// determinísticas deste repo por cima.
//
// Tudo que decide "passar pra humano" sem gastar LLM, e tudo que barra um
// texto do LLM antes de sair, mora aqui. O manual (docs/agente-whatsapp-manual.md)
// vai no prompt, mas prompt é pedido, não garantia: o que dá pra checar com
// regex é checado aqui.

// ── Constantes ────────────────────────────────────────────────────────────

// DM do Instagram aceita até 1000 bytes UTF-8. Acima disso passa pra humano:
// truncar no meio de uma frase seria pior que não responder.
export const LIMITE_BYTES_DM = 1000;

export const JANELA_24H_MS = 24 * 3600_000;

// Eco com o mesmo texto da nossa última resposta, até 2 min depois, é nosso.
export const ECO_PROPRIO_MS = 2 * 60_000;

// Black Friday (manual, seção 2): só de 24/11/2026 00:00 a 30/11/2026 23:59 BRT.
export const BLACK_FRIDAY_INICIO = Date.parse("2026-11-24T00:00:00.000-03:00");
export const BLACK_FRIDAY_FIM = Date.parse("2026-11-30T23:59:59.999-03:00");

// Link do pedido que o prompt manda usar (o manual manda um link do pedido;
// aqui não existe a ferramenta link_pedido do painel). A trava aceita
// qualquer caminho https de eternizacards.com.br (ver linkPermitido).
export const LINK_PEDIDO = "https://eternizacards.com.br/?utm_source=instagram&utm_medium=dm&utm_campaign=direct";
const HOSTS_PERMITIDOS = new Set(["eternizacards.com.br", "www.eternizacards.com.br"]);

// Frase pro cliente quando a conversa passa pra humano (DM_FRASE_HUMANO troca).
export const FRASE_HUMANO_PADRAO = "Vou chamar o Vini pra te ajudar com isso, ele te responde aqui rapidinho 😊";

// Planos que dá pra somar (manual, seção 3b, 7b: "até 20 cartas, é só juntar
// os planos no site"). Valores em centavos.
const UNICA = { cartas: 1, centavos: 3990 };
const TRIO = { cartas: 3, centavos: 9990 };
export const MAX_CARTAS_SEM_COTACAO = 20;

// Preços aceitos no texto: os do manual (seção 2: Única 39,90, Trio 99,90,
// Black Friday 99,90 e o frete da Única "entre R$ 8 e R$ 20") e toda soma
// a×Única + b×Trio com a + 3b ≤ 20 cartas (ex.: 79,80, 139,80, 199,80).
// Qualquer outro R$ (desconto, preço inventado, combinação acima de 20
// cartas) passa pra humano.
export const PRECOS_PERMITIDOS = (() => {
  const s = new Set([800, 2000, UNICA.centavos, TRIO.centavos]);
  for (let b = 0; b * TRIO.cartas <= MAX_CARTAS_SEM_COTACAO; b++) {
    for (let a = 0; a * UNICA.cartas + b * TRIO.cartas <= MAX_CARTAS_SEM_COTACAO; a++) {
      if (a + b > 0) s.add(a * UNICA.centavos + b * TRIO.centavos);
    }
  }
  return s;
})();

// Prazos (manual, seção 3, pedido novo): arte em até 3 dias úteis, produção
// em 4 dias úteis. "N dias úteis" com outro N passa pra humano (pega soma
// "7 dias úteis" e o regime antigo).
const DIAS_UTEIS_DO_MANUAL = new Set([3, 4]);

// Motivos do passar_para_humano no manual (seção 14). O modelo escolhe um.
export const MOTIVOS_MODELO = ["COTAÇÃO", "AJUSTE", "ENTREGA", "CANCELAMENTO", "CONFIANÇA", "ELOGIO", "SEGURANÇA", "OUTRO"];

// ── Texto ─────────────────────────────────────────────────────────────────

// Minúsculas e sem acento (mesmo jeito de api/contas.js).
export function normalizar(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export const bytesUtf8 = (s) => Buffer.byteLength(String(s ?? ""), "utf8");

// ── Evento do webhook → mensagem ──────────────────────────────────────────

// Tipo do anexo do Instagram → tipo gravado em ig_dm_mensagens.tipo.
const TIPO_ANEXO = {
  image: "imagem",
  video: "video",
  audio: "audio",
  file: "arquivo",
  share: "compartilhamento",
  ig_reel: "compartilhamento",
  reel: "compartilhamento",
  story_mention: "story",
};

export const TIPOS_MENSAGEM = ["texto", "imagem", "video", "audio", "arquivo", "compartilhamento", "story", "anexo", "nao_suportado"];

// Classifica um item de entry.messaging. Devolve null pro que a gente
// ignora (read, reaction, message_edit, postback, referral, apagada...).
//   { tipo: "entrada", igsid, mid, texto, tipoMsg, em }
//   { tipo: "eco",     igsid, mid, texto, tipoMsg, em }   (igsid = recipient.id)
export function classificarEvento(ev, contaUserId) {
  if (!ev || typeof ev !== "object") return null;
  const m = ev.message;
  if (!m || typeof m !== "object") return null; // read, reaction, postback, message_edit...
  if (m.is_deleted) return null;
  if (!m.mid) return null;

  const texto = typeof m.text === "string" && m.text.trim() ? m.text : null;
  let tipoMsg = "texto";
  if (m.is_unsupported) tipoMsg = "nao_suportado";
  else if (!texto) {
    const anexo = Array.isArray(m.attachments) ? m.attachments[0] : null;
    tipoMsg = anexo ? TIPO_ANEXO[anexo.type] || "anexo" : "anexo";
  }
  const ts = Number(ev.timestamp);
  const em = Number.isFinite(ts) && ts > 0 ? new Date(ts) : null;

  if (m.is_echo === true) {
    const igsid = ev.recipient?.id;
    if (!igsid) return null;
    return { tipo: "eco", igsid: String(igsid), mid: String(m.mid), texto, tipoMsg, em };
  }
  const igsid = ev.sender?.id;
  if (!igsid) return null;
  // mensagem "da própria conta" sem is_echo: não é cliente
  if (contaUserId && String(igsid) === String(contaUserId)) return null;
  return { tipo: "entrada", igsid: String(igsid), mid: String(m.mid), texto, tipoMsg, em };
}

// ── Turno ─────────────────────────────────────────────────────────────────

const ROTULO = {
  imagem: "mandou uma foto",
  video: "mandou um vídeo",
  arquivo: "mandou um arquivo",
  compartilhamento: "compartilhou um post",
  story: "mencionou a gente num story",
  anexo: "mandou um anexo",
  nao_suportado: "mandou algo que o Instagram não mostra por aqui",
};

// Junta as mensagens que o cliente mandou em sequência num texto só pro
// modelo (mesma ideia do montarTurno do painel).
export function montarTurno(msgs) {
  const temAudio = msgs.some((m) => m.tipo === "audio");
  const partes = [];
  for (const m of msgs) {
    if (m.tipo === "audio") continue;
    const r = ROTULO[m.tipo];
    if (r) partes.push(m.texto ? `[o cliente ${r}, com a legenda: ${m.texto}]` : `[o cliente ${r}]`);
    else if (m.texto) partes.push(m.texto);
  }
  if (temAudio) partes.push("[o cliente mandou um áudio, que você não consegue ouvir: peça com carinho pra escrever o que disse no áudio]");
  return partes.join("\n");
}

// ── Pré-checagem (antes do LLM, sem gastar nada) ──────────────────────────

const POR_EXTENSO = {
  vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70,
  oitenta: 80, noventa: 90, cem: 100, cento: 100, duzentas: 200, trezentas: 300,
  quinhentas: 500, mil: 1000,
};

// Maior quantidade de cartas citada no texto ("25 cartas", "trinta cards").
export function quantidadeDeCartas(textoNormalizado) {
  let maior = 0;
  const re = /(?:(\d{1,5})\s*|\b([a-z]+)\s+)(?:cartas?|cartinhas?|cards?|unidades|lembrancinhas?)\b/g;
  for (const m of textoNormalizado.matchAll(re)) {
    const n = m[1] ? Number(m[1]) : POR_EXTENSO[m[2]] ?? 0;
    maior = Math.max(maior, n);
  }
  // "vinte cartas" é 20 (pode); "vinte e cinco cartas" passa de 20
  for (const m of textoNormalizado.matchAll(/\b(vinte|trinta|quarenta|cinquenta)\s+e\s+[a-z]+\s+(?:cartas?|cartinhas?|cards?)\b/g)) {
    maior = Math.max(maior, POR_EXTENSO[m[1]] + 1);
  }
  return maior;
}

// O cliente fala de um pedido que JÁ existe ("meu pedido", "comprei", "já
// paguei", "#1234", "pedido 1234"...). Sem isso, "correios", "entrega",
// "endereço", "devolução" são pergunta de pré-venda e o modelo responde.
const RE_PEDIDO_FEITO =
  /\bmeu pedido|\bmeus pedidos|\bminha encomenda|\bminha compra|\bcomprei\b|\bpaguei\b|\bja pago\b|\bfiz (?:o|um|uma|meu|a|minha) (?:pedido|compra|encomenda)|\bfiz o pagamento|#\s?\d{2,}|\bpedido\s*(?:n[o.º°]?\s*)?#?\s*\d{3,}/;

// re: vai pra humano sempre. reComPedido: só quando há contexto de pedido
// já feito (RE_PEDIDO_FEITO). Ordem = prioridade do motivo.
const PRE_CHECAGEM = [
  {
    motivo: "reclamacao",
    re: /reclama|procon|reclame aqui|pessim|horrivel|absurdo|decepcion|insatisfeit|veio errad|chegou errad|danificad|amassad|rasgad|defeit|(?:chegou|veio|carta|cartas) quebrad|nao gostei/,
  },
  {
    motivo: "cancelamento",
    re: /cancel|reembols|estorn|dinheiro de volta|arrependi/,
    reComPedido: /devolu|devolv/,
  },
  {
    motivo: "pagamento",
    re: /paguei|ja pago|nao consegui pagar|pagamento (recusad|nao|falhou|deu erro|pendente)|cartao (recusad|nao passou)|recusad|cobrad[oa] (duas|2) vezes|pix (nao|errad)|nao caiu/,
    reComPedido: /cobranca|cobrad|comprovante|nota fiscal/,
  },
  {
    motivo: "entrega",
    re: /extravi|codigo de rastreio|\bmeu rastreio|cade (o |a |meu |minha |as |os )?(pedido|carta|cartas|encomenda)/,
    reComPedido: /rastrei|rastrear|nao chegou|nao receb|correios|transportadora|entregue|entrega|endereco|atrasad|atraso|postad|chega quando|quando chega/,
  },
];

// Devolve { motivo, detalhe } se o turno do cliente já pede humano, senão null.
export function preChecagem(textoTurno) {
  const t = normalizar(textoTurno);
  if (!t.trim()) return null;
  const pedido = RE_PEDIDO_FEITO.exec(t);
  for (const regra of PRE_CHECAGEM) {
    const m = regra.re.exec(t);
    if (m) return { motivo: regra.motivo, detalhe: `palavra-chave: "${m[0]}"` };
    const c = pedido && regra.reComPedido?.exec(t);
    if (c) return { motivo: regra.motivo, detalhe: `palavra-chave: "${c[0]}" com pedido já feito ("${pedido[0]}")` };
  }
  const n = quantidadeDeCartas(t);
  if (n > 20) return { motivo: "quantidade", detalhe: `${n} cartas (acima de 20 é cotação do Vini)` };
  return null;
}

// ── Travas no texto que o LLM quer mandar ─────────────────────────────────

// 8+ dígitos seguidos, aceitando espaço, ponto, hífen, parênteses e "+" no
// meio: (11) 98765-4321, +55 11 98765 4321, 987654321. Barra e vírgula NÃO
// contam como separador, então data (24/11/2026) e preço (R$ 99,90) passam.
const RE_TELEFONE = /(?:\+?\d[\s().\-]{0,3}){8,}/;
// Não são telefone (tirados do texto antes do RE_TELEFONE): CNPJ formatado
// (12.345.678/0001-90), CEP 01310-100 (5-3, sem dígito colado dos lados) e
// 8 dígitos logo depois de "CEP" (CEP 01310100, CEP: 01.310-100).
const RE_CNPJ = /(?<!\d)\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}(?!\d)/g;
const RE_CEP = /(?<![\d.\-])\d{5}-\d{3}(?![\d.\-]?\d)|\bcep\b\W{0,3}\d{2}\.?\d{3}-?\d{3}(?!\d)/gi;

export function temTelefone(texto) {
  const s = String(texto ?? "").replace(RE_CNPJ, " ").replace(RE_CEP, " ");
  return RE_TELEFONE.test(s);
}

export const blackFridayAtiva = (agoraMs) => agoraMs >= BLACK_FRIDAY_INICIO && agoraMs <= BLACK_FRIDAY_FIM;

// "1.234,5" → 123450 (centavos); null se não for número.
function precoEmCentavos(bruto) {
  const n = Number(bruto.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// Prazo que soma etapas num número só ou que é do regime antigo (manual,
// seção 3: "nunca some as etapas num número só"; 48 horas úteis é só de
// pedido antigo, que o direct não consulta). "3 a 7 dias" (frete) e
// "7 dias corridos" (arrependimento) passam.
const NUMERO = "(?:\\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|quinze)";
const RE_PRAZO_TOTAL = [
  // 48h, 48 h, 48hs, 48 horas (úteis ou não)
  /\b48\s*(?:h|hs|hrs?|horas?)\b/,
  // "pronto em 7 dias", "chega em 10 dias", "fica pronta em até 7 dias"
  new RegExp(`\\b(?:pront[oa]s?|fica(?:m)?|chega(?:m)?|receb\\w*|entreg\\w*)\\s+(?:em|com)\\s+(?:ate\\s+)?(?:uns\\s+)?${NUMERO}\\s+(?:dias?|semanas?)\\b(?!\\s+(?:uteis|corridos))`),
  // "em até 7 dias", "em 10 dias" (sem "úteis", que tem regra própria, nem "corridos")
  new RegExp(`\\bem\\s+(?:ate\\s+)?${NUMERO}\\s+dias?\\b(?!\\s+(?:uteis|corridos))`),
  // "uma semana", "2 semanas"
  new RegExp(`\\b${NUMERO}\\s+semanas?\\b`),
  // "prazo total de 10 dias", "no total são 9 dias"
  /\btotal\b[^.!?\n]{0,30}?\b\d+\s+dias?\b/,
];

// Só https de eternizacards.com.br (com ou sem www.), qualquer caminho,
// query ou âncora. Sem usuário/senha nem porta (pega o truque
// https://eternizacards.com.br@outro.site).
export function linkPermitido(bruto) {
  let u;
  try {
    u = new URL(/^www\./i.test(bruto) ? `https://${bruto}` : bruto);
  } catch {
    return false;
  }
  return u.protocol === "https:" && HOSTS_PERMITIDOS.has(u.hostname.toLowerCase()) && !u.username && !u.password && !u.port;
}

// Domínio sem http(s):// nem www. ("bit.ly/x", "wa.me/...", "outrosite.com").
const RE_DOMINIO_SOLTO = /(?<![@\w.\/-])(?:[a-z0-9-]+\.)+(?:com|net|org|me|ly|io|br|app|link|co|gg|site|store|shop|info|bio)(?:\.[a-z]{2})?\b(?:\/[^\s]*)?/gi;

// Devolve { motivo, detalhe } se o texto NÃO pode sair, senão null.
export function travasDoTexto(texto, agoraMs) {
  const s = String(texto ?? "");
  if (!s.trim()) return { motivo: "texto_vazio", detalhe: "o modelo devolveu texto vazio" };

  const bytes = bytesUtf8(s);
  if (bytes > LIMITE_BYTES_DM) return { motivo: "tamanho", detalhe: `${bytes} bytes (limite ${LIMITE_BYTES_DM})` };

  if (temTelefone(s)) return { motivo: "telefone", detalhe: "sequência de 8+ dígitos no texto (não é CEP nem CNPJ)" };

  const t = normalizar(s);
  if (/\bblack\b|blackfriday/.test(t) && !blackFridayAtiva(agoraMs)) {
    return { motivo: "black_friday", detalhe: "menciona Black Friday fora de 24/11 00:00 a 30/11 23:59 BRT" };
  }

  for (const m of s.matchAll(/R\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/g)) {
    const p = precoEmCentavos(m[1]);
    if (p == null || !PRECOS_PERMITIDOS.has(p)) {
      return { motivo: "preco_fora_do_manual", detalhe: `preço "${m[0]}" não está no manual nem é soma de planos até ${MAX_CARTAS_SEM_COTACAO} cartas` };
    }
  }

  for (const m of t.matchAll(/(\d+)\s*(?:dias?|horas?)\s+uteis/g)) {
    const n = Number(m[1]);
    if (!/dias?/.test(m[0]) || !DIAS_UTEIS_DO_MANUAL.has(n)) {
      return { motivo: "prazo_fora_do_manual", detalhe: `prazo "${m[0]}" não é 3 (arte) nem 4 (produção) dias úteis` };
    }
  }
  for (const re of RE_PRAZO_TOTAL) {
    const m = re.exec(t);
    if (m) return { motivo: "prazo_fora_do_manual", detalhe: `prazo "${m[0]}" soma etapas ou é do regime antigo` };
  }

  // Vocabulário (manual + contexto): antes do pagamento é "arte"; o texto
  // não usa "prévia". Não tem falso positivo: nenhuma resposta certa usa a palavra.
  if (/\bprevias?\b/.test(t)) return { motivo: "vocabulario_previa", detalhe: "o texto usa \"prévia\" (o certo é falar da arte, feita depois do pagamento)" };

  for (const m of s.matchAll(/(?:https?:\/\/|www\.)[^\s]+/gi)) {
    const url = m[0].replace(/[).,!?;:]+$/, "");
    if (!linkPermitido(url)) return { motivo: "link_fora_do_manual", detalhe: `link não permitido: ${url.slice(0, 120)}` };
  }
  const semLinks = s.replace(/(?:https?:\/\/|www\.)[^\s]+/gi, " ");
  for (const m of semLinks.matchAll(RE_DOMINIO_SOLTO)) {
    const dominio = m[0].replace(/[).,!?;:]+$/, "");
    if (!linkPermitido(`https://${dominio}`)) return { motivo: "link_fora_do_manual", detalhe: `link não permitido: ${dominio.slice(0, 120)}` };
  }
  return null;
}

// Frase que vai pro cliente quando a conversa passa pra humano. DM_FRASE_HUMANO
// troca o texto; se a da env não passar nas travas (telefone, link, preço,
// tamanho...), usa a padrão e devolve o motivo pra logar.
export function fraseHumano(env = process.env, agoraMs = Date.now()) {
  const daEnv = String(env.DM_FRASE_HUMANO ?? "").trim();
  if (!daEnv) return { texto: FRASE_HUMANO_PADRAO, recusada: null };
  const trava = travasDoTexto(daEnv, agoraMs);
  if (trava) return { texto: FRASE_HUMANO_PADRAO, recusada: trava.motivo };
  return { texto: daEnv, recusada: null };
}

// ── Resposta do LLM ───────────────────────────────────────────────────────

// O modelo devolve JSON {acao, texto, motivo, confianca}. Aceita cerca de
// ```json e texto em volta; qualquer outra coisa é inválida (→ humano).
export function lerRespostaModelo(conteudo) {
  const bruto = String(conteudo ?? "").trim();
  const ini = bruto.indexOf("{");
  const fim = bruto.lastIndexOf("}");
  if (ini < 0 || fim <= ini) return { ok: false, erro: "resposta sem JSON" };
  let j;
  try {
    j = JSON.parse(bruto.slice(ini, fim + 1));
  } catch {
    return { ok: false, erro: "JSON inválido" };
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, erro: "JSON não é objeto" };
  if (j.acao !== "responder" && j.acao !== "humano") return { ok: false, erro: `acao inválida: ${String(j.acao).slice(0, 40)}` };
  const confianca = typeof j.confianca === "number" ? j.confianca : Number(j.confianca);
  if (!Number.isFinite(confianca) || confianca < 0 || confianca > 1) return { ok: false, erro: "confianca fora de 0..1" };
  return {
    ok: true,
    acao: j.acao,
    texto: typeof j.texto === "string" ? j.texto.trim() : "",
    motivo: typeof j.motivo === "string" ? j.motivo.trim().slice(0, 40) : "",
    confianca,
  };
}

// ── Contexto pro prompt ───────────────────────────────────────────────────

// Partes da data em BRT (a Vercel roda em UTC).
function brt(d) {
  const f = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit",
    year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const iso = `${p.year}-${p.month}-${p.day}`;
  const semana = new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0 = domingo
  return { iso, semana, hora: Number(p.hour), minuto: Number(p.minute), texto: `${p.weekday} ${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}` };
}

const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

// Atendimento humano: dias úteis, 8h às 20h (manual, seção 8). Sem tabela de
// feriados aqui: num feriado o modelo diz que o Vini está "aberto".
export function horarioHumano(agora) {
  const b = brt(agora);
  const util = (semana) => semana >= 1 && semana <= 5;
  const minutos = b.hora * 60 + b.minuto;
  if (util(b.semana) && minutos >= 8 * 60 && minutos < 20 * 60) return { aberto: true, volta: "agora" };
  if (util(b.semana) && minutos < 8 * 60) return { aberto: false, volta: "hoje a partir das 8h" };
  for (let n = 1; n <= 7; n++) {
    const d = new Date(`${b.iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    if (util(d.getUTCDay())) return { aberto: false, volta: n === 1 ? "amanhã a partir das 8h" : `${DIAS[d.getUTCDay()]} a partir das 8h` };
  }
  return { aberto: false, volta: "no próximo dia útil a partir das 8h" };
}

// Bloco que vai depois do manual no system prompt. O que está aqui vale mais
// que o manual (o manual foi escrito pro WhatsApp, com ferramentas).
export function contexto(agora) {
  const h = horarioHumano(agora);
  const bf = blackFridayAtiva(agora.getTime());
  return [
    "## Contexto desta conversa (gerado pelo sistema, não pelo cliente)",
    `- Agora: ${brt(agora).texto} (horário de Brasília).`,
    "- Canal: Direct do Instagram (@eternizacards). NÃO é WhatsApp: onde o manual diz \"aqui no WhatsApp\", entenda \"aqui no direct\". O direct não tem negrito: não use asterisco nem markdown.",
    `- Atendimento humano (Vini): ${h.aberto ? "aberto agora" : `fechado, volta ${h.volta}`}.`,
    bf
      ? "- Black Friday: ATIVA agora (até 30/11/2026 23:59). Pode explicar a condição da tabela da seção 2 se o cliente perguntar de promoção ou cupom."
      : "- Black Friday: NÃO está ativa agora. Não escreva \"Black Friday\" nem \"black\", não diga que vai ter promoção nem a data. Pergunta de cupom: \"No momento não temos cupom ativo, mas o Trio já vem com frete grátis pro Brasil todo\".",
    "",
    "## Regras deste canal (valem mais que o manual)",
    "- Aqui você NÃO tem ferramentas: não existe consultar_pedido, link_pedido nem passar_para_humano. Você só devolve o JSON abaixo.",
    "- Este direct é só pra tirar dúvida e levar o cliente a fazer o pedido no site. Aqui NÃO se recebe foto, NÃO se coleta nome e NÃO se aprova arte, e você não vê imagens (só sabe que veio um anexo). O pedido é feito no site eternizacards.com.br; depois de pagar, o cliente recebe um link pra mandar as fotos e os nomes (o pós-compra). Se ele mandar foto ou quiser mandar por aqui, agradeça com carinho e explique isso.",
    "- Nunca mande o cliente pro WhatsApp: sem número de telefone, sem wa.me, sem \"chama no zap\".",
    "- Do manual, IGNORE (é do WhatsApp e não vale aqui): a seção 3b inteira sobre saudação, origem, UTM e montagem do link (aqui o link é o de baixo); qualquer instrução de pedir, receber ou organizar fotos e nomes \"aqui\" na conversa (seções 4, 5 e 11); o regime antigo de 48 horas úteis; e a consulta de pedido por telefone ou número (seções 4, 13 e 14).",
    "- Você não vê pedido nenhum. Qualquer coisa sobre um pedido já feito (pagamento, etapa, prazo de um pedido, rastreio, entrega, troca, devolução, endereço, envio de fotos de um pedido pago, ajuste de arte) → acao \"humano\".",
    `- Link do pedido: este, exatamente assim: ${LINK_PEDIDO} . Não invente outro caminho do site e nunca mande link de outro domínio.`,
    `- Preços: os da tabela da seção 2 do manual, escritos como lá. Pode somar os planos pra combinações até ${MAX_CARTAS_SEM_COTACAO} cartas (Única R$ 39,90 por 1 carta, Trio R$ 99,90 por 3 cartas; ex.: Trio + Única = 4 cartas por R$ 139,80; dois Trios = 6 cartas por R$ 199,80). Acima de ${MAX_CARTAS_SEM_COTACAO} cartas não dê preço: acao "humano" com motivo "COTAÇÃO". Nunca dê desconto, nunca invente preço.`,
    "- Prazo: a arte fica pronta em até 3 dias úteis depois que chegam as fotos e os nomes de todas as cartas (ou da carta, se for uma só); a produção leva 4 dias úteis depois que o cliente aprova a arte; o frete leva de 3 a 7 dias, contados da postagem. Nunca some as etapas num número só (nada de \"pronto em 7 dias\", \"uma semana\" ou \"48 horas\").",
    "- Antes do pagamento não existe arte. Se pedirem amostra ou pra ver antes de pagar, diga que a arte é feita depois do pagamento e só vai pra impressão depois do OK do cliente, com ajustes sem custo até ele aprovar. Fale sempre em \"arte\"; não use a palavra \"prévia\" na resposta.",
    "- Nunca escreva número de telefone ou de WhatsApp, nem peça o do cliente.",
    "- Não diga nada que não esteja no manual. Na dúvida, acao \"humano\".",
    `- Acima de ${MAX_CARTAS_SEM_COTACAO} cartas, reclamação, cancelamento, reembolso, problema de pagamento ou de entrega, pedido já feito, pedido pra falar com uma pessoa, segurança → acao "humano".`,
    "- Elogio: responda normalmente (acao \"responder\") com motivo \"ELOGIO\".",
    "- Quando a acao for \"humano\", o texto que você escrever NÃO é enviado: um humano assume a conversa.",
    "- Responda em português, curto, no tom do manual. Uma mensagem só, até 600 caracteres.",
    "",
    "## Formato da resposta (obrigatório)",
    "Responda SÓ com um objeto JSON, sem nada antes ou depois:",
    `{"acao": "responder" ou "humano", "texto": "a mensagem pro cliente", "motivo": um de ${MOTIVOS_MODELO.join(", ")} ou "", "confianca": número de 0 a 1 (o quanto você tem certeza de que a resposta está 100% dentro do manual)}`,
  ].join("\n");
}

// A Meta só aceita texto livre até 24h depois da última mensagem do cliente.
export const janelaAberta = (ultimaEntradaMs, agoraMs) =>
  Number.isFinite(ultimaEntradaMs) && agoraMs - ultimaEntradaMs < JANELA_24H_MS;
