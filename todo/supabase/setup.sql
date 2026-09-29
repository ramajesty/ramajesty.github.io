-- Outline Todo: Supabase setup
-- Supabase の SQL Editor に全文を貼り付けて Run してください。
-- 何度実行しても同じ状態になるように書いてあります。

create extension if not exists pg_trgm;

-- ============================================================
-- テーブル
-- ============================================================

create table if not exists public.folders (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  parent_id  uuid references public.folders(id) on delete set null,
  name       text not null default '',
  sort_key   text collate "C" not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table public.folders enable row level security;

create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  folder_id    uuid references public.folders(id) on delete set null,
  title        text not null default '',
  sort_key     text collate "C" not null,
  show_checked boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
alter table public.documents enable row level security;

create table if not exists public.nodes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  parent_id   uuid,
  sort_key    text collate "C" not null,
  content     text not null default '',
  note        text not null default '',
  checkbox    boolean not null default false,
  checked     boolean not null default false,
  collapsed   boolean not null default false,
  due_at      timestamptz,
  tags        text[] not null default array[]::text[],
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
alter table public.nodes enable row level security;

create table if not exists public.attachments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  node_id      uuid,
  file_name    text not null default '',
  mime_type    text not null default '',
  size         bigint not null default 0,
  storage_path text not null,
  thumb_path   text,
  width        int,
  height       int,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
alter table public.attachments enable row level security;

-- ============================================================
-- インデックス
-- ============================================================

create index if not exists folders_user_idx      on public.folders (user_id);
create index if not exists documents_user_idx    on public.documents (user_id);
create index if not exists nodes_document_idx    on public.nodes (document_id);
create index if not exists nodes_user_due_idx    on public.nodes (user_id, due_at)
  where due_at is not null and deleted_at is null;
create index if not exists nodes_tags_idx        on public.nodes using gin (tags);
create index if not exists nodes_content_trgm    on public.nodes using gin (content gin_trgm_ops);
create index if not exists nodes_note_trgm       on public.nodes using gin (note gin_trgm_ops);
create index if not exists attachments_user_idx  on public.attachments (user_id);
create index if not exists attachments_node_idx  on public.attachments (node_id);

-- ============================================================
-- updated_at の自動更新
-- ============================================================

create or replace function public.set_updated_at() returns trigger
language plpgsql as 'begin new.updated_at := now(); return new; end;';

drop trigger if exists folders_updated_at   on public.folders;
drop trigger if exists documents_updated_at on public.documents;
drop trigger if exists nodes_updated_at     on public.nodes;
create trigger folders_updated_at   before update on public.folders   for each row execute function public.set_updated_at();
create trigger documents_updated_at before update on public.documents for each row execute function public.set_updated_at();
create trigger nodes_updated_at     before update on public.nodes     for each row execute function public.set_updated_at();

-- ============================================================
-- アクセス制限(RLS): 本人の行だけ読み書きできる(RLS 自体は各表の作成直後でオン)
-- ============================================================

drop policy if exists "own rows" on public.folders;
drop policy if exists "own rows" on public.documents;
drop policy if exists "own rows" on public.nodes;
drop policy if exists "own rows" on public.attachments;
create policy "own rows" on public.folders     for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.documents   for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.nodes       for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.attachments for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.folders, public.documents, public.nodes, public.attachments from anon;
grant select, insert, update, delete
  on public.folders, public.documents, public.nodes, public.attachments to authenticated;

-- ============================================================
-- ファイル置き場(非公開、1ファイル20MBまで)
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = 20971520;

-- パスの先頭フォルダが自分のユーザーIDのファイルだけ扱える
drop policy if exists "attachments own files select" on storage.objects;
drop policy if exists "attachments own files insert" on storage.objects;
drop policy if exists "attachments own files update" on storage.objects;
drop policy if exists "attachments own files delete" on storage.objects;
create policy "attachments own files select" on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "attachments own files insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "attachments own files update" on storage.objects for update to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "attachments own files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ============================================================
-- リアルタイム同期の対象に追加
-- ============================================================

do '
declare t text;
begin
  foreach t in array array[''folders'', ''documents'', ''nodes''] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = ''supabase_realtime'' and schemaname = ''public'' and tablename = t
    ) then
      execute format(''alter publication supabase_realtime add table public.%I'', t);
    end if;
  end loop;
end;
';

-- 完了確認用: 4行(attachments, documents, folders, nodes)が表示されれば成功
select table_name from information_schema.tables
where table_schema = 'public' and table_name in ('folders', 'documents', 'nodes', 'attachments')
order by table_name;
