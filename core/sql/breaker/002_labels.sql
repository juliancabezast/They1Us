-- The sticker list for the demo tables. Run on the Breaker DB.
-- Labels point at tables that live in the CUSTOMER DB, in its schema (public unless CUSTOMER_SCHEMA says otherwise;
-- core/sql/apply.ts passes it as breaker.customer_schema).

-- Label every column an outsider can write to. A missed label is a hole.
insert into breaker.column_labels (table_schema, table_name, column_name, label)
select coalesce(nullif(current_setting('breaker.customer_schema', true), ''), 'public'), v.table_name, v.column_name, v.label
from (values
  ('support_tickets',    'customer_email', 'untrusted'),
  ('support_tickets',    'subject',        'untrusted'),
  ('support_tickets',    'body',           'untrusted'),
  ('integration_tokens', 'token',          'secret')
) as v(table_name, column_name, label)
on conflict do nothing;
