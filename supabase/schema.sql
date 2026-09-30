-- Run once in a NEW Supabase project's SQL Editor. Safe to rerun.
begin;
create table if not exists public.study_board (
  id integer primary key check (id = 1),
  revision bigint not null default 0,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.study_board enable row level security;
revoke all on public.study_board from public, anon, authenticated;
grant select, update on public.study_board to service_role;
insert into public.study_board(id, payload)
values (1, '{"members":[],"records":[],"periods":[]}')
on conflict(id) do nothing;

-- Row lock + compare-and-swap: stale clients can never overwrite new work.
create or replace function public.save_study_board(expected_revision bigint, next_payload jsonb)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare new_revision bigint;
begin
  if pg_catalog.octet_length(next_payload::text) > 47185920 then
    raise exception 'BOARD_TOO_LARGE';
  end if;
  update public.study_board set payload = next_payload,
    revision = revision + 1, updated_at = now()
  where id = 1 and revision = expected_revision
  returning revision into new_revision;
  if new_revision is null then raise exception 'REVISION_CONFLICT'; end if;
  return new_revision;
end;
$$;
revoke all on function public.save_study_board(bigint,jsonb) from public, anon, authenticated;
grant execute on function public.save_study_board(bigint,jsonb) to service_role;
-- A private bucket: no anon/authenticated access policies are added.
-- All photo reads go through the Render server's per-record permission checks.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('study-photos','study-photos',false,3145728,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false, file_size_limit=3145728,
  allowed_mime_types=array['image/jpeg','image/png','image/webp'];
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('study-pdfs','study-pdfs',false,12582912,array['application/pdf'])
on conflict(id) do update set public=false, file_size_limit=12582912,
  allowed_mime_types=array['application/pdf'];
commit;
