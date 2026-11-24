-- 021: more branding (Admin > Branding): a product title, a logo for the Dark theme and an app
-- icon, in the one branding row. The service checks every value; the checks here only keep a wrong
-- write out. All are optional: null keeps the default (the product name, the logo, the built-in
-- icons).

alter table branding
  -- Plain text: trimmed, 1 to 40 characters, on one line, without control characters.
  add column title text check (
    title is null
    or (
      char_length(title) between 1 and 40
      and title = btrim(title)
      and title !~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]'
    )
  ),
  add column dark_logo bytea check (dark_logo is null or octet_length(dark_logo) between 1 and 307200),
  add column dark_logo_type text check (dark_logo_type in ('image/png', 'image/jpeg', 'image/webp')),
  -- A PNG of 512 x 512 pixels (the service reads the size from the file).
  add column icon bytea check (icon is null or octet_length(icon) between 1 and 307200),
  add column icon_type text check (icon_type = 'image/png'),
  add check ((dark_logo is null) = (dark_logo_type is null)),
  add check ((icon is null) = (icon_type is null));
