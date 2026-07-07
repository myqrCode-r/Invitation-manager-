-- Apply these statements in the Supabase SQL editor.

-- Allow public read access to invitation images.
create policy if not exists "Allow public read access to invitations"
  on storage.objects for select
  using (bucket_id = 'invitations');

-- Allow anonymous or authenticated uploads to the invitations bucket.
create policy if not exists "Allow uploads to invitations"
  on storage.objects for insert
  with check (
    bucket_id = 'invitations'
    and auth.role() in ('anon', 'authenticated')
  );

-- Allow anonymous or authenticated deletion of uploaded invitation files.
create policy if not exists "Allow delete of invitations"
  on storage.objects for delete
  using (
    bucket_id = 'invitations'
    and auth.role() in ('anon', 'authenticated')
  );
