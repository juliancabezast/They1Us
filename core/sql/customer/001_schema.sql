-- Customer DB ("the bank"): the tables the support app and its AI agent work on.
-- Run on the Customer DB. core/sql/apply.ts runs it inside the customer schema
-- (public unless CUSTOMER_SCHEMA says otherwise), so names here are unqualified.
-- This file is the single source of truth for the demo tables: the victim app uses them and does not create its own.

create table if not exists support_tickets (
  id             bigserial primary key,
  customer_email text not null,
  subject        text not null,
  body           text not null,
  reply          text,
  created_at     timestamptz not null default now()
);

create table if not exists integration_tokens (
  id      bigserial primary key,
  service text not null unique,
  token   text not null
);

create table if not exists customers (
  id   bigserial primary key,
  name text not null unique,
  plan text not null
);

-- The identity the Breaker runs agent SQL as. It can do the support agent's job on these
-- three tables and nothing else: no DDL, no other schema. The Breaker connects with the
-- customer's connection string and switches to this role for every statement.
do $$
begin
  if not exists (select from pg_roles where rolname = 'breaker_agent') then
    create role breaker_agent nologin;
  end if;
  execute format('grant usage on schema %I to breaker_agent', current_schema());
end $$;
grant breaker_agent to current_user;
grant select, insert, update, delete on support_tickets to breaker_agent;
grant usage on sequence support_tickets_id_seq to breaker_agent;
grant select on integration_tokens, customers to breaker_agent;

-- Row level security on, so the project's public API key cannot read these tables.
-- The agent role gets explicit policies; the table owner (the customer's own app) is not affected.
alter table support_tickets enable row level security;
alter table integration_tokens enable row level security;
alter table customers enable row level security;

drop policy if exists breaker_agent_tickets on support_tickets;
create policy breaker_agent_tickets on support_tickets for all to breaker_agent using (true) with check (true);
drop policy if exists breaker_agent_tokens on integration_tokens;
create policy breaker_agent_tokens on integration_tokens for select to breaker_agent using (true);
drop policy if exists breaker_agent_customers on customers;
create policy breaker_agent_customers on customers for select to breaker_agent using (true);
