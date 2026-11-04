-- Plays Ranch MCP Connector v1 — registry schema.
-- Target: Postgres 15+ (Supabase-compatible). Additive only; no destructive statements.
-- Apply with an owner/admin role. The connector itself connects as plays_ranch_connector (read-only).

create schema if not exists registry;

create table if not exists registry.companies (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- Server-enforced authorization: which OAuth subjects may read which company's records.
create table if not exists registry.company_memberships (
  user_subject text not null,                       -- `sub` claim from the authorization server
  company_id   uuid not null references registry.companies(id) on delete cascade,
  role         text not null default 'viewer' check (role in ('viewer', 'operator', 'owner')),
  created_at   timestamptz not null default now(),
  primary key (user_subject, company_id)
);

create table if not exists registry.plugins (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references registry.companies(id),
  slug             text not null check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name             text not null,
  summary          text not null default '',
  capabilities     text[] not null default '{}',
  availability     text not null default 'internal'
                   check (availability in ('internal', 'private_beta', 'available', 'suspended', 'retired')),
  current_version  text,
  permissions      text[] not null default '{}',
  dependencies     text[] not null default '{}',
  support_owner    text not null,
  support_channel  text,
  support_docs_url text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, slug)
);
create index if not exists plugins_company_idx on registry.plugins (company_id);
create index if not exists plugins_capabilities_idx on registry.plugins using gin (capabilities);

create table if not exists registry.verification_reports (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references registry.companies(id),
  plugin_id   uuid not null references registry.plugins(id),
  version     text not null,
  status      text not null check (status in ('pending', 'passed', 'conditional', 'failed')),
  verified_at timestamptz,
  verifier    text,
  -- [{kind, title, uri, recorded_at}]
  evidence    jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  -- [{id, severity, title, status, detail}]
  findings    jsonb not null default '[]'::jsonb check (jsonb_typeof(findings) = 'array'),
  created_at  timestamptz not null default now()
);
create index if not exists verification_plugin_version_idx
  on registry.verification_reports (plugin_id, version, created_at desc);

create table if not exists registry.releases (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references registry.companies(id),
  plugin_id   uuid not null references registry.plugins(id),
  version     text not null,
  channel     text not null,
  status      text not null
              check (status in ('planned', 'in_review', 'approved', 'released', 'rolled_back', 'withdrawn')),
  notes       text,
  approved_by text,
  released_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists releases_company_created_idx on registry.releases (company_id, created_at desc);

create table if not exists registry.handoffs (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references registry.companies(id),
  plugin_id       uuid references registry.plugins(id),
  kind            text not null check (kind in ('engineering', 'operations')),
  title           text not null,
  status          text not null
                  check (status in ('DRAFT', 'READY', 'ACCEPTED', 'BLOCKED', 'REVIEW', 'COMPLETE', 'ARCHIVED')),
  approval_status text not null default 'pending' check (approval_status in ('pending', 'approved', 'rejected')),
  approved_by     text,
  approved_at     timestamptz,
  summary         text not null default '',
  body            text not null default '',  -- markdown; must not contain secret values
  source_uri      text,
  updated_at      timestamptz not null default now(),
  check (approval_status <> 'approved' or (approved_by is not null and approved_at is not null))
);
create index if not exists handoffs_company_idx on registry.handoffs (company_id);

-- Child records must belong to the same company as their plugin.
create or replace function registry.enforce_plugin_company() returns trigger
language plpgsql as $$
begin
  if new.plugin_id is not null and not exists (
    select 1 from registry.plugins p where p.id = new.plugin_id and p.company_id = new.company_id
  ) then
    raise exception 'plugin % does not belong to company %', new.plugin_id, new.company_id;
  end if;
  return new;
end $$;

drop trigger if exists verification_company_check on registry.verification_reports;
create trigger verification_company_check before insert or update on registry.verification_reports
  for each row execute function registry.enforce_plugin_company();
drop trigger if exists releases_company_check on registry.releases;
create trigger releases_company_check before insert or update on registry.releases
  for each row execute function registry.enforce_plugin_company();
drop trigger if exists handoffs_company_check on registry.handoffs;
create trigger handoffs_company_check before insert or update on registry.handoffs
  for each row execute function registry.enforce_plugin_company();

-- Defense in depth: enable RLS with no policies so Supabase anon/authenticated API roles read nothing.
alter table registry.companies            enable row level security;
alter table registry.company_memberships  enable row level security;
alter table registry.plugins              enable row level security;
alter table registry.verification_reports enable row level security;
alter table registry.releases             enable row level security;
alter table registry.handoffs             enable row level security;

-- Read-only role for the connector. Set its password out of band (never in this file):
--   alter role plays_ranch_connector with login password '<from secrets manager>';
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'plays_ranch_connector') then
    create role plays_ranch_connector nologin;
  end if;
end $$;
grant usage on schema registry to plays_ranch_connector;
grant select on all tables in schema registry to plays_ranch_connector;
alter role plays_ranch_connector set default_transaction_read_only = on;
-- The connector role bypasses RLS only via an explicit permissive policy scoped to itself.
do $$
declare t text;
begin
  foreach t in array array['companies','company_memberships','plugins','verification_reports','releases','handoffs'] loop
    execute format('drop policy if exists connector_read on registry.%I', t);
    execute format('create policy connector_read on registry.%I for select to plays_ranch_connector using (true)', t);
  end loop;
end $$;
