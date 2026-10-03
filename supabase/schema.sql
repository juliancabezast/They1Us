-- Trifecta Breaker: schema for the DEMO database. Synthetic data only.
-- Re-running this file drops and recreates every table below.

drop table if exists tb_events, tb_approvals, tb_sessions, tb_contexts, tb_column_labels cascade;
drop table if exists support_tickets, integration_tokens cascade;

-- Demo application tables -----------------------------------------------------
create table support_tickets (
  id bigint generated always as identity primary key,
  run_id uuid not null,               -- isolates the fixtures of each demo run
  customer_email text not null,
  subject text not null,
  body text not null,
  reply text,
  replied_at timestamptz,
  created_at timestamptz not null default now()
);
create index on support_tickets (run_id);

create table integration_tokens (
  id bigint generated always as identity primary key,
  service text not null unique,
  token text not null                 -- fictitious values only
);

-- Breaker tables --------------------------------------------------------------
-- A column may carry both labels.
create table tb_column_labels (
  table_name text not null,
  column_name text not null,
  label text not null check (label in ('untrusted', 'secret')),
  primary key (table_name, column_name, label)
);

-- The root of an agent execution. Labels accumulate here and are never cleared.
create table tb_contexts (
  id uuid primary key default gen_random_uuid(),
  principal text not null,
  mode text not null check (mode in ('protected', 'sandbox')),
  kind text not null,
  run_id uuid not null,
  has_untrusted boolean not null default false,
  has_secret boolean not null default false,
  created_at timestamptz not null default now()
);

-- Server-issued handles onto a context. A new session never means a new context.
create table tb_sessions (
  id uuid primary key default gen_random_uuid(),
  context_id uuid not null references tb_contexts (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table tb_approvals (
  id uuid primary key default gen_random_uuid(),
  context_id uuid not null references tb_contexts (id) on delete cascade,
  operation text not null,
  operation_version int not null,
  destination text not null,
  content text not null,
  content_sha256 text not null,
  state_fingerprint text not null,
  policy_version text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'used')),
  decided_by text,
  decided_at timestamptz,
  used_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table tb_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  correlation_id uuid not null,
  context_id uuid references tb_contexts (id) on delete cascade,
  session_id uuid,
  actor text not null,
  operation text not null,
  decision text not null check (decision in
    ('ALLOWED', 'DENIED', 'APPROVAL_REQUIRED', 'APPROVED', 'REJECTED', 'EXECUTION_FAILED', 'UNCHECKED')),
  reason_code text not null,
  labels text[] not null default '{}',
  state_before jsonb,
  state_after jsonb,
  policy_version text not null,
  duration_ms numeric,
  execution_result text,              -- outcome of running it, separate from the decision
  params jsonb not null default '{}'  -- redacted: content is stored as hash + length
);
create index on tb_events (context_id);

-- Least privilege for the executor ---------------------------------------------
-- Catalog operations run under this role. It cannot see any tb_* table, so an
-- operation cannot touch policy, audit or approvals even if its SQL were wrong.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'tb_executor') then
    create role tb_executor nologin;
  end if;
end $$;
grant tb_executor to current_user;
grant usage on schema public to tb_executor;
grant select on support_tickets, integration_tokens to tb_executor;
grant update (reply, replied_at) on support_tickets to tb_executor;

alter table support_tickets enable row level security;
alter table integration_tokens enable row level security;
alter table tb_column_labels enable row level security;
alter table tb_contexts enable row level security;
alter table tb_sessions enable row level security;
alter table tb_approvals enable row level security;
alter table tb_events enable row level security;

create policy "executor reads tickets" on support_tickets for select to tb_executor using (true);
create policy "executor replies to tickets" on support_tickets for update to tb_executor using (true) with check (true);
create policy "executor reads tokens" on integration_tokens for select to tb_executor using (true);

-- The dashboard's Realtime subscription uses the publishable key. Events are redacted.
create policy "dashboard reads events" on tb_events for select to anon using (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'tb_events') then
    alter publication supabase_realtime add table tb_events;
  end if;
end $$;

-- Seed ------------------------------------------------------------------------
insert into tb_column_labels (table_name, column_name, label) values
  ('support_tickets', 'customer_email', 'untrusted'),
  ('support_tickets', 'subject', 'untrusted'),
  ('support_tickets', 'body', 'untrusted'),
  ('integration_tokens', 'token', 'secret');

insert into integration_tokens (service, token) values
  ('billing-api', 'DEMO_ONLY_NOT_A_REAL_TOKEN_7F3A'),
  ('chat-api', 'DEMO_ONLY_NOT_A_REAL_TOKEN_C21B');
