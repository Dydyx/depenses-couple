-- =============================================================
-- Dépenses du couple : base de données Supabase
-- À coller tel quel dans Supabase > SQL Editor > New query > Run
-- =============================================================

create extension if not exists pgcrypto with schema extensions;

-- Données de l'appli (une ligne par onglet + une ligne de réglages)
create table if not exists public.app_data (
  key        text primary key check (key in ('dyd', 'meg', 'couple', 'settings')),
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Mot de passe (stocké haché avec bcrypt, jamais en clair)
create table if not exists public.app_secret (
  id       int primary key default 1 check (id = 1),
  pwd_hash text not null
);

-- Aucun accès direct aux tables depuis l'extérieur : tout passe par les fonctions ci-dessous
alter table public.app_data   enable row level security;
alter table public.app_secret enable row level security;
revoke all on public.app_data, public.app_secret from anon, authenticated;

-- Mot de passe initial : "coucou"
insert into public.app_secret (id, pwd_hash)
values (1, extensions.crypt('coucou', extensions.gen_salt('bf')))
on conflict (id) do update set pwd_hash = excluded.pwd_hash;

-- Vérification du mot de passe (interne)
create or replace function public.app_check(pwd text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.app_secret s
    where s.id = 1 and s.pwd_hash = extensions.crypt(coalesce(pwd, ''), s.pwd_hash)
  );
$$;
revoke all on function public.app_check(text) from public, anon, authenticated;

-- Lecture de toutes les données (si le mot de passe est bon)
create or replace function public.app_load(pwd text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.app_check(pwd) then
    perform pg_sleep(1); -- ralentit les essais de mots de passe
    raise exception 'denied' using errcode = '28P01';
  end if;
  return coalesce((select jsonb_object_agg(d.key, d.value) from public.app_data d), '{}'::jsonb);
end;
$$;

-- Enregistrement d'un onglet (si le mot de passe est bon)
create or replace function public.app_save(pwd text, k text, v jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.app_check(pwd) then
    perform pg_sleep(1);
    raise exception 'denied' using errcode = '28P01';
  end if;
  if k not in ('dyd', 'meg', 'couple', 'settings') then
    raise exception 'bad key';
  end if;
  if pg_column_size(v) > 1000000 then
    raise exception 'too large';
  end if;
  insert into public.app_data (key, value, updated_at)
  values (k, v, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$$;

revoke all on function public.app_load(text) from public;
revoke all on function public.app_save(text, text, jsonb) from public;
grant execute on function public.app_load(text) to anon, authenticated;
grant execute on function public.app_save(text, text, jsonb) to anon, authenticated;

-- -------------------------------------------------------------
-- Pour changer le mot de passe plus tard (remplacer NOUVEAU) :
-- update public.app_secret
--   set pwd_hash = extensions.crypt('NOUVEAU', extensions.gen_salt('bf'))
--   where id = 1;
-- -------------------------------------------------------------
