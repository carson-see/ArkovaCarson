-- Elite Finish Detailing — bookings schema
create schema if not exists elite_finish;

create table if not exists elite_finish.bookings (
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

create index if not exists bookings_created_at_idx on elite_finish.bookings (created_at desc);
create index if not exists bookings_status_idx    on elite_finish.bookings (status);

-- Enable row level security
alter table elite_finish.bookings enable row level security;

-- Expose schema to PostgREST
grant usage on schema elite_finish to anon, authenticated;
grant insert on elite_finish.bookings to anon;
grant select, insert, update, delete on elite_finish.bookings to authenticated;

-- Allow anonymous customers to insert bookings (but not read others')
drop policy if exists "anon can insert bookings" on elite_finish.bookings;
create policy "anon can insert bookings"
  on elite_finish.bookings
  for insert
  to anon
  with check (true);

-- Logged-in users (e.g. the owners via dashboard) can read/update
drop policy if exists "authenticated can read" on elite_finish.bookings;
create policy "authenticated can read"
  on elite_finish.bookings
  for select
  to authenticated
  using (true);

drop policy if exists "authenticated can update" on elite_finish.bookings;
create policy "authenticated can update"
  on elite_finish.bookings
  for update
  to authenticated
  using (true)
  with check (true);
;
