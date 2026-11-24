create extension if not exists pgcrypto;

create table if not exists public.merchants (
  id text primary key,
  name text not null default 'Merchant',
  email text not null unique,
  password text not null default '',
  business_name text not null default 'Store',
  upi_id text not null default '',
  qr_image_path text not null default '/uploads/default-qr.jpeg',
  gmail_user text not null default '',
  gmail_app_pass text not null default '',
  api_key text,
  is_onboarded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  order_id text primary key,
  merchant_id text not null,
  amount numeric(12, 2) not null,
  customer_name text not null default 'Customer',
  customer_email text not null default '',
  note text not null default '',
  status text not null default 'PENDING'
    check (status in ('PENDING', 'PAID', 'SUCCESS', 'FAILED')),
  dynamic_upi_url text not null default '',
  dynamic_qr_data_url text not null default '',
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  payment_details jsonb
);

create index if not exists orders_merchant_status_created_at_idx
  on public.orders (merchant_id, status, created_at desc);

grant usage on schema public to service_role;
grant all privileges on table public.merchants to service_role;
grant all privileges on table public.orders to service_role;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  role text not null default 'merchant'
    check (role in ('merchant', 'admin', 'super_admin')),
  account_status text not null default 'active'
    check (account_status in ('active', 'suspended')),
  permissions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.merchants
  add column if not exists auth_user_id uuid references auth.users(id) on delete cascade,
  add column if not exists phone text not null default '',
  add column if not exists payee_name text not null default '',
  add column if not exists target_app text not null default '',
  add column if not exists website_url text not null default '',
  add column if not exists review_status text not null default 'pending'
    check (review_status in ('pending', 'under_review', 'approved', 'denied')),
  add column if not exists reviewed_by uuid references auth.users(id),
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text not null default '',
  add column if not exists gmail_app_pass_encrypted text not null default '';

alter table public.merchants alter column api_key drop not null;
alter table public.merchants alter column is_onboarded set default false;
alter table public.merchants drop column if exists password;
alter table public.merchants drop column if exists gmail_app_pass;
alter table public.merchants drop constraint if exists merchants_email_key;
update public.merchants
  set api_key = null,
      is_onboarded = false,
      review_status = case when auth_user_id is null then 'denied' else 'pending' end,
      gmail_app_pass_encrypted = '';
delete from public.merchants where id = 'merch_default';
delete from public.orders where merchant_id = 'merch_default';
create unique index if not exists merchants_auth_user_id_key
  on public.merchants (auth_user_id) where auth_user_id is not null;
create index if not exists merchants_review_status_created_at_idx
  on public.merchants (review_status, created_at desc);

create table if not exists public.feature_flags (
  id uuid primary key default gen_random_uuid(),
  flag_key text not null,
  enabled boolean not null default false,
  user_id uuid references auth.users(id) on delete cascade,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (flag_key, user_id)
);

create table if not exists public.system_settings (
  setting_key text primary key,
  setting_value jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

insert into public.system_settings (setting_key, setting_value)
values ('maintenance', '{"enabled": false, "message": "We are performing scheduled maintenance."}'::jsonb)
on conflict (setting_key) do nothing;

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id),
  action text not null,
  target_type text not null,
  target_id text not null default '',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_created_at_idx on public.audit_logs (created_at desc);

grant all privileges on table public.profiles to service_role;
grant all privileges on table public.feature_flags to service_role;
grant all privileges on table public.system_settings to service_role;
grant all privileges on table public.audit_logs to service_role;

create or replace function public.admin_metrics()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'merchants', (select count(*) from public.merchants where auth_user_id is not null),
    'pendingApplications', (select count(*) from public.merchants where auth_user_id is not null and review_status = 'pending'),
    'underReviewApplications', (select count(*) from public.merchants where auth_user_id is not null and review_status = 'under_review'),
    'approvedMerchants', (select count(*) from public.merchants where auth_user_id is not null and review_status = 'approved'),
    'totalOrders', (select count(*) from public.orders),
    'paidOrders', (select count(*) from public.orders where status = 'PAID'),
    'paidVolume', (select coalesce(sum(amount), 0) from public.orders where status = 'PAID'),
    'activeUsers', (select count(*) from public.profiles where account_status = 'active'),
    'suspendedUsers', (select count(*) from public.profiles where account_status = 'suspended')
  );
$$;

create or replace function public.merchant_metrics(target_merchant_id text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'totalOrders', count(*),
    'paidCount', count(*) filter (where status = 'PAID'),
    'pendingCount', count(*) filter (where status = 'PENDING'),
    'totalVolume', coalesce(sum(amount) filter (where status = 'PAID'), 0)
  )
  from public.orders
  where merchant_id = target_merchant_id;
$$;

revoke all on function public.admin_metrics() from public, anon, authenticated;
revoke all on function public.merchant_metrics(text) from public, anon, authenticated;
grant execute on function public.admin_metrics() to service_role;
grant execute on function public.merchant_metrics(text) to service_role;

alter table public.profiles enable row level security;
alter table public.merchants enable row level security;
alter table public.feature_flags enable row level security;
alter table public.system_settings enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
  on public.profiles for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can read their own merchant application" on public.merchants;
create policy "Users can read their own merchant application"
  on public.merchants for select to authenticated
  using (auth.uid() = auth_user_id);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''),
    case when lower(coalesce(new.email, '')) = 'shashanksv2009@gmail.com'
      then 'super_admin' else 'merchant' end
  )
  on conflict (user_id) do update
    set email = excluded.email,
        full_name = case when public.profiles.full_name = ''
          then excluded.full_name else public.profiles.full_name end,
        role = case when lower(excluded.email) = 'shashanksv2009@gmail.com'
          then 'super_admin'
          when lower(coalesce(public.profiles.email, '')) = 'shashanksv2009@gmail.com'
          then 'merchant'
          else public.profiles.role end,
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update on auth.users
  for each row execute procedure public.handle_new_auth_user();

insert into public.profiles (user_id, email, full_name, role)
select id, coalesce(email, ''), coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name', ''),
  case when lower(coalesce(email, '')) = 'shashanksv2009@gmail.com'
    then 'super_admin' else 'merchant' end
from auth.users
on conflict (user_id) do update
  set role = case when lower(excluded.email) = 'shashanksv2009@gmail.com'
    then 'super_admin' else public.profiles.role end,
      email = excluded.email,
      updated_at = now();
