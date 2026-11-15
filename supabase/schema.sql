-- Flowstate database. Paste into Supabase: SQL Editor > New query > Run.

-- One row per signed-in user: onboarding survey answers.
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  persona text,                 -- trader, investor, fund, builder, analyst, creator, exploring
  markets text[] default '{}',  -- markets they follow
  capital text,                 -- size bucket, optional
  goals text[] default '{}',    -- what they want from Flowstate
  region text,
  heard_from text,
  newsletter boolean default false,
  telegram text,
  onboarded_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.profiles enable row level security;
drop policy if exists "read own profile" on public.profiles;
drop policy if exists "insert own profile" on public.profiles;
drop policy if exists "update own profile" on public.profiles;
create policy "read own profile" on public.profiles for select using (auth.uid() = id);
create policy "insert own profile" on public.profiles for insert with check (auth.uid() = id);
create policy "update own profile" on public.profiles for update using (auth.uid() = id);

-- Newsletter list. Written only by the server (service role); no public access.
create table if not exists public.subscribers (
  email text primary key,
  source text,                  -- footer, blog, onboarding, ...
  persona text,
  user_id uuid references auth.users on delete set null,
  created_at timestamptz default now(),
  unsubscribed_at timestamptz
);
alter table public.subscribers enable row level security;

-- Handy views for you in the Supabase table editor.
create or replace view public.persona_breakdown as
  select persona, count(*) as users from public.profiles where onboarded_at is not null group by persona order by users desc;
revoke all on public.persona_breakdown from anon, authenticated;
