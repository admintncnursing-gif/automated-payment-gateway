-- Initial ArchXpay schema for Supabase.
create table if not exists public.merchants (
  id text primary key,
  name text not null default 'Merchant',
  email text not null unique,
  password text not null,
  business_name text not null default 'Store',
  upi_id text not null default '',
  qr_image_path text not null default '/uploads/default-qr.jpeg',
  gmail_user text not null default '',
  gmail_app_pass text not null default '',
  api_key text not null unique,
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

alter table public.merchants enable row level security;
alter table public.orders enable row level security;
