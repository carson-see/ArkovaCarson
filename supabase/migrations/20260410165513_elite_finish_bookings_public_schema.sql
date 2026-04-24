-- Move to public schema so PostgREST auto-exposes it.
drop table if exists elite_finish.bookings;
drop schema if exists elite_finish cascade;

create table if not exists public.elite_finish_bookings (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  status          text not null default 'new' check (status in ('new','confirmed','in_progress','completed','cancelled')),
  name            text not null,
  email           text not null,
  phone           text not null,
  vehicle         text not null check (vehicle in ('Car','Truck','SUV','Van','Exotic/Classic')),
  service         text not null check (service in ('Exterior','Interior','Both','Custom Quote')),
  addons          text[] not null default '{}',
  service_date    date,
  service_time    text,
  address         text not null,
  notes           text,
  estimated_total integer
);

create index if not exists elite_finish_bookings_created_at_idx on public.elite_finish_bookings (created_at desc);
create index if not exists elite_finish_bookings_status_idx    on public.elite_finish_bookings (status);

alter table public.elite_finish_bookings enable row level security;

-- Anonymous customers can submit bookings but cannot read any.
drop policy if exists "anon insert bookings" on public.elite_finish_bookings;
create policy "anon insert bookings"
  on public.elite_finish_bookings
  for insert
  to anon
  with check (true);

-- Owners (authenticated via Supabase dashboard) can read and manage.
drop policy if exists "authenticated manage bookings" on public.elite_finish_bookings;
create policy "authenticated manage bookings"
  on public.elite_finish_bookings
  for all
  to authenticated
  using (true)
  with check (true);

grant insert on public.elite_finish_bookings to anon;
grant all    on public.elite_finish_bookings to authenticated;
;
