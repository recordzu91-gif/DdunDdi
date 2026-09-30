-- Existing deployment update: adds only a private PDF bucket.
-- Does not read, rewrite, delete or reset any accounts, records or photos.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('study-pdfs','study-pdfs',false,12582912,array['application/pdf'])
on conflict(id) do update set public=false, file_size_limit=12582912,
  allowed_mime_types=array['application/pdf'];
-- Do not add public read policies. Render checks record permissions.
