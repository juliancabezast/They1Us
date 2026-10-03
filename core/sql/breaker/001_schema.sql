-- Breaker DB (ours): labels, session stamps and the decision log.
-- Run on the Breaker DB. Additive and idempotent.

create schema if not exists breaker;

-- Labels point at tables that live in the CUSTOMER DB.
create table if not exists breaker.column_labels (
  table_schema text not null default 'public',
  table_name   text not null,
  column_name  text not null,
  label        text not null check (label in ('untrusted', 'secret')),
  primary key (table_schema, table_name, column_name)
);
alter table breaker.column_labels alter column table_schema set default 'public';

create table if not exists breaker.sessions (
  id            uuid primary key default gen_random_uuid(),
  label         text,                              -- who opened it: http, replay:A:protected, mcp, test
  has_untrusted boolean not null default false,
  has_secret    boolean not null default false,
  created_at    timestamptz not null default now()
);

create table if not exists breaker.events (
  id            bigserial primary key,
  session_id    uuid not null references breaker.sessions(id) on delete cascade,
  sql           text not null,                     -- string literals masked: the log never carries data
  sql_sha256    text not null,                     -- hash of the statement exactly as the agent sent it
  relations     jsonb not null default '[]',
  is_write      boolean not null default false,
  decision      text not null check (decision in ('allow', 'deny')),
  rule          text not null,
  reason        text not null,
  flags_before  jsonb not null,
  flags_after   jsonb not null,
  error_code    text,                              -- SQLSTATE when an allowed statement failed while running
  created_at    timestamptz not null default now()
);
create index if not exists events_session_idx on breaker.events (session_id, id);

-- Nobody but the Breaker's own connection reads or writes bookkeeping.
alter table breaker.column_labels enable row level security;
alter table breaker.sessions enable row level security;
alter table breaker.events enable row level security;
revoke all on schema breaker from public;
revoke all on all tables in schema breaker from public;
