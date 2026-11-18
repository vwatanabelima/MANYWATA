-- DMs do @eternizacards: gravação e resposta automática (MANYWATA,
-- api/_lib/dm.js). NÃO é aplicada sozinha: rode no projeto eternizacards
-- (ksjvuvpnctdzapazoypy) pelo SQL Editor ou `supabase db push`, uma vez.
--
-- Por que schema public com prefixo ig_dm_: o PostgREST do Supabase só expõe
-- o schema public por padrão, e o webhook fala com o banco via PostgREST
-- (fetch nativo, sem SDK). Um schema próprio exigiria mexer em "Exposed
-- schemas" do projeto. O prefixo separa estas tabelas das do painel
-- (painel_*) e da loja.
--
-- Segurança: RLS ligada em todas e NENHUMA policy. Com isso anon e
-- authenticated (chave pública do site/painel) não leem nem escrevem nada;
-- só a service_role, que passa por cima de RLS, usada pelo webhook na Vercel
-- (env DM_SUPABASE_SERVICE_ROLE_KEY). Além disso, revoke explícito pra
-- anon/authenticated, porque o Supabase dá grant padrão em tabela nova do public.
--
-- Também cria: a view ig_dm_pendentes_humano (fila do Vinicius) e a função
-- ig_dm_expurgar(dias) (retenção; o agendamento com pg_cron fica comentado).

begin;

-- ── Conversas (uma por cliente) ───────────────────────────────────────────

create table if not exists public.ig_dm_conversas (
  id                    bigint generated always as identity primary key,
  igsid                 text not null unique,          -- id do cliente no Instagram (escopo da conta)
  conta                 text not null default 'eterniza',
  ultima_entrada_em     timestamptz,                   -- última mensagem do cliente (timestamp do evento)
  ultima_saida_em       timestamptz,                   -- última resposta automática enviada
  -- passou pra humano: a automação não responde mais nesta conversa
  humano                boolean not null default false,
  humano_motivo         text,
  humano_em             timestamptz,
  -- a frase "vou chamar o Vini" já foi pro cliente nesta marcação (PATCH
  -- condicional: sai no máximo uma vez). Volta pra automação: zere junto.
  humano_frase_enviada_em timestamptz,
  -- o Vinicius respondeu pelo app (eco manual): automação pausada
  pausada_manual        boolean not null default false,
  pausada_motivo        text,
  pausada_em            timestamptz,
  -- trava atômica: só quem fizer o PATCH condicional (livre ou vencida)
  -- responde; vence sozinha (90s) se a função morrer no meio
  respondendo_ate       timestamptz,
  trava_id              uuid,
  -- limite de respostas automáticas por janela de 24h
  auto_respostas_janela integer not null default 0 check (auto_respostas_janela >= 0),
  janela_inicio_em      timestamptz,
  -- texto e hora da última resposta automática, gravados ANTES do envio: o
  -- eco do nosso envio pode chegar antes de gravarmos o mid
  ultima_auto_texto     text,
  ultima_auto_em        timestamptz,
  criado_em             timestamptz not null default now(),
  atualizado_em         timestamptz not null default now()
);

comment on table public.ig_dm_conversas is
  'DMs do Instagram (@eternizacards): uma linha por cliente (igsid). Escrita só pelo webhook do MANYWATA com a service role.';
comment on column public.ig_dm_conversas.humano is
  'true = passou pra humano; a resposta automática não responde mais. Volta pra automação: update ... set humano = false, humano_frase_enviada_em = null.';
comment on column public.ig_dm_conversas.pausada_manual is
  'true = o Vinicius respondeu pelo app (eco); a resposta automática para nesta conversa.';
comment on column public.ig_dm_conversas.respondendo_ate is
  'Trava atômica da resposta automática (PATCH condicional no PostgREST). Null = livre.';

create index if not exists ig_dm_conversas_humano_idx
  on public.ig_dm_conversas (humano_em desc) where humano;
create index if not exists ig_dm_conversas_pausada_idx
  on public.ig_dm_conversas (pausada_em desc) where pausada_manual;

-- ── Mensagens ─────────────────────────────────────────────────────────────

create table if not exists public.ig_dm_mensagens (
  id         bigint generated always as identity primary key,
  mid        text not null unique,                     -- id da mensagem na Meta (idempotência)
  igsid      text not null references public.ig_dm_conversas (igsid) on delete cascade,
  texto      text,                                     -- null quando é só anexo
  tipo       text not null default 'texto'
             check (tipo in ('texto', 'imagem', 'video', 'audio', 'arquivo', 'compartilhamento', 'story', 'anexo', 'nao_suportado')),
  direcao    text not null check (direcao in ('entrada', 'saida_auto', 'eco_manual')),
  -- sistema = frase fixa ao passar pra humano (DM_FRASE_HUMANO)
  origem     text check (origem in ('cliente', 'llm', 'comentario', 'vinicius', 'sistema')),
  enviada_em timestamptz not null,                     -- timestamp do evento (entrada/eco) ou do envio (saída)
  criado_em  timestamptz not null default now()        -- quando gravou aqui (ordem da conversa)
);

comment on table public.ig_dm_mensagens is
  'Mensagens das DMs. direcao: entrada (cliente), saida_auto (resposta automática ou DM do comentário→DM), eco_manual (o Vinicius pelo app).';

create index if not exists ig_dm_mensagens_conversa_idx
  on public.ig_dm_mensagens (igsid, criado_em desc, id desc);

-- ── Log ───────────────────────────────────────────────────────────────────

create table if not exists public.ig_dm_log (
  id          bigint generated always as identity primary key,
  tipo        text not null check (tipo in ('resposta', 'humano', 'frase_humano', 'erro_envio', 'bloqueio')),
  igsid       text,                                    -- sem FK: o log sobrevive à conversa
  mid_entrada text,
  mid_saida   text,
  texto       text,                                    -- o que saiu (resposta) ou o que o LLM queria mandar
  modelo      text,
  custo_usd   numeric(12, 6),                          -- usage.cost do OpenRouter
  confianca   numeric(4, 3),
  motivo      text,
  detalhe     text,                                    -- sempre sanitizado (sem token)
  criado_em   timestamptz not null default now()
);

comment on table public.ig_dm_log is
  'Cada resposta automática enviada, cada passagem pra humano (e a frase de espera que foi pro cliente), cada falha de envio e cada bloqueio (fora da janela, sem chave do LLM...).';

create index if not exists ig_dm_log_criado_idx on public.ig_dm_log (criado_em desc);
create index if not exists ig_dm_log_igsid_idx on public.ig_dm_log (igsid, criado_em desc);
create index if not exists ig_dm_log_tipo_idx on public.ig_dm_log (tipo, criado_em desc);

-- ── Fila do Vinicius: conversas que passaram pra humano ───────────────────
-- Passou pra humano e ninguém respondeu ainda pelo app (o eco manual marca
-- pausada_manual e tira daqui). É o registro que sempre existe, com ou sem
-- aviso por Telegram. security_invoker: a view roda com a permissão de quem
-- consulta, então a RLS das tabelas vale (anon/authenticated não veem nada).

create or replace view public.ig_dm_pendentes_humano
with (security_invoker = true) as
select
  c.igsid,
  c.conta,
  c.humano_motivo as motivo,
  c.humano_em,
  c.humano_frase_enviada_em,
  c.ultima_entrada_em,
  (select m.texto
     from public.ig_dm_mensagens m
    where m.igsid = c.igsid and m.direcao = 'entrada'
    order by m.criado_em desc, m.id desc
    limit 1) as ultimo_texto_cliente,
  (select l.detalhe
     from public.ig_dm_log l
    where l.igsid = c.igsid and l.tipo = 'humano'
    order by l.criado_em desc, l.id desc
    limit 1) as detalhe
from public.ig_dm_conversas c
where c.humano and not c.pausada_manual
order by c.humano_em desc nulls last;

comment on view public.ig_dm_pendentes_humano is
  'DMs que passaram pra humano e ainda não foram atendidas pelo app (sem eco manual). Motivo, hora, último texto do cliente.';

-- ── Retenção ──────────────────────────────────────────────────────────────
-- Apaga mensagens e logs com mais de N dias (padrão 180) e conversas sem
-- mensagem nem movimento nesse período. 180 dias cobre arrependimento
-- (7 dias), entrega atrasada (art. 35) e contestação de cartão (até ~180
-- dias) sem guardar conversa pra sempre (LGPD: minimização).
-- security definer + search_path vazio: roda como dono da função, com nomes
-- todos qualificados; só a service_role executa.

create or replace function public.ig_dm_expurgar(dias integer default 180)
returns table (mensagens_apagadas bigint, logs_apagados bigint, conversas_apagadas bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  corte timestamptz;
  n_msg bigint;
  n_log bigint;
  n_conv bigint;
begin
  if dias is null or dias < 1 then
    raise exception 'ig_dm_expurgar: dias precisa ser >= 1 (veio %)', dias;
  end if;
  corte := pg_catalog.now() - pg_catalog.make_interval(days => dias);

  delete from public.ig_dm_mensagens where criado_em < corte;
  get diagnostics n_msg = row_count;

  delete from public.ig_dm_log where criado_em < corte;
  get diagnostics n_log = row_count;

  delete from public.ig_dm_conversas c
   where c.atualizado_em < corte
     and coalesce(c.ultima_entrada_em, c.criado_em) < corte
     and not exists (select 1 from public.ig_dm_mensagens m where m.igsid = c.igsid);
  get diagnostics n_conv = row_count;

  return query select n_msg, n_log, n_conv;
end;
$$;

comment on function public.ig_dm_expurgar(integer) is
  'Retenção das DMs: apaga mensagens/logs com mais de N dias (padrão 180) e conversas sem mensagem recente. Só service_role.';

-- Agendamento (NÃO ativado; precisa da extensão pg_cron ligada no projeto).
-- Pra ligar, rode à mão no SQL Editor:
--   select cron.schedule('ig_dm_expurgar', '30 6 * * 0', $cron$select public.ig_dm_expurgar(180)$cron$);
-- (domingo 06:30 UTC). Pra desligar: select cron.unschedule('ig_dm_expurgar');

-- ── Acesso: só service_role ───────────────────────────────────────────────

alter table public.ig_dm_conversas enable row level security;
alter table public.ig_dm_mensagens enable row level security;
alter table public.ig_dm_log enable row level security;
-- (nenhuma policy, de propósito)

revoke all on table public.ig_dm_conversas, public.ig_dm_mensagens, public.ig_dm_log from anon, authenticated;
revoke all on sequence public.ig_dm_conversas_id_seq, public.ig_dm_mensagens_id_seq, public.ig_dm_log_id_seq from anon, authenticated;
revoke all on table public.ig_dm_pendentes_humano from anon, authenticated;
revoke all on function public.ig_dm_expurgar(integer) from public, anon, authenticated;

grant select, insert, update, delete on table public.ig_dm_conversas, public.ig_dm_mensagens, public.ig_dm_log to service_role;
grant usage, select on sequence public.ig_dm_conversas_id_seq, public.ig_dm_mensagens_id_seq, public.ig_dm_log_id_seq to service_role;
grant select on table public.ig_dm_pendentes_humano to service_role;
grant execute on function public.ig_dm_expurgar(integer) to service_role;

commit;
