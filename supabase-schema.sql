-- supabase-schema.sql
-- Выполнить один раз в Supabase: SQL Editor -> New query -> Run.
-- Это упрощённая база для GitHub Pages без отдельного backend.
-- Первый зарегистрированный пользователь получает роль owner через online-auth.js.

create table if not exists public.rppilot_users (
    static_id text primary key check (static_id ~ '^[0-9]{3}-[0-9]{3}$'),
    login text unique,
    password_hash text not null,
    first_name text not null,
    last_name text not null,
    rank text not null default 'Рядовой',
    callsign text not null default '',
    roles text[] not null default array['user'],
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.rppilot_audit_logs (
    id bigserial primary key,
    actor_static_id text,
    action text not null,
    target_static_id text,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create or replace function public.rppilot_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists rppilot_users_touch_updated_at on public.rppilot_users;

create trigger rppilot_users_touch_updated_at
before update on public.rppilot_users
for each row
execute function public.rppilot_touch_updated_at();

-- Упрощённый режим: сайт на GitHub Pages сможет читать и писать данные через anon key.
-- Это НЕ безопасный режим, но он работает без отдельного backend.
alter table public.rppilot_users disable row level security;
alter table public.rppilot_audit_logs disable row level security;

grant select, insert, update, delete on public.rppilot_users to anon;
grant select, insert, update, delete on public.rppilot_users to authenticated;
grant select, insert on public.rppilot_audit_logs to anon;
grant select, insert on public.rppilot_audit_logs to authenticated;
grant usage, select on sequence public.rppilot_audit_logs_id_seq to anon;
grant usage, select on sequence public.rppilot_audit_logs_id_seq to authenticated;
