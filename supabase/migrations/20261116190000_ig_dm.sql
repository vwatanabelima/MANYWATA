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
  'true = passou pra humano; a resposta automática não responde mais. Volta pra automação: update ... set humano = false.';
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
  origem     text check (origem in ('cliente', 'llm', 'comentario', 'vinicius')),
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
  tipo        text not null check (tipo in ('resposta', 'humano', 'erro_envio', 'bloqueio')),
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
  'Cada resposta automática enviada, cada passagem pra humano, cada falha de envio e cada bloqueio (fora da janela, erro do LLM...).';

create index if not exists ig_dm_log_criado_idx on public.ig_dm_log (criado_em desc);
create index if not exists ig_dm_log_igsid_idx on public.ig_dm_log (igsid, criado_em desc);
create index if not exists ig_dm_log_tipo_idx on public.ig_dm_log (tipo, criado_em desc);

-- ── Acesso: só service_role ───────────────────────────────────────────────

alter table public.ig_dm_conversas enable row level security;
alter table public.ig_dm_mensagens enable row level security;
alter table public.ig_dm_log enable row level security;
-- (nenhuma policy, de propósito)

revoke all on table public.ig_dm_conversas, public.ig_dm_mensagens, public.ig_dm_log from anon, authenticated;
revoke all on sequence public.ig_dm_conversas_id_seq, public.ig_dm_mensagens_id_seq, public.ig_dm_log_id_seq from anon, authenticated;

grant select, insert, update, delete on table public.ig_dm_conversas, public.ig_dm_mensagens, public.ig_dm_log to service_role;
grant usage, select on sequence public.ig_dm_conversas_id_seq, public.ig_dm_mensagens_id_seq, public.ig_dm_log_id_seq to service_role;

commit;
