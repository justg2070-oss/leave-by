-- Leave By database: one saved planner per person.
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.

create table if not exists public.planners (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  state      text not null,
  saved_at   bigint,
  updated_at timestamptz not null default now()
);

-- Row-level security: each signed-in person can only read and write their own row.
alter table public.planners enable row level security;

drop policy if exists "Read own planner" on public.planners;
create policy "Read own planner" on public.planners
  for select using (auth.uid() = user_id);

drop policy if exists "Create own planner" on public.planners;
create policy "Create own planner" on public.planners
  for insert with check (auth.uid() = user_id);

drop policy if exists "Update own planner" on public.planners;
create policy "Update own planner" on public.planners
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Keep updated_at current on every save.
create or replace function public.touch_planner() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists planners_touch on public.planners;
create trigger planners_touch before update on public.planners
  for each row execute function public.touch_planner();
