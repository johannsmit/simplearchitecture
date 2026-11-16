-- 015: view folders. A view can be in one folder, one level deep. A folder is only a name on the
-- views in it: it exists while a view is in it, so there are no empty folders and no table of its
-- own. The app compares folder names ignoring case and spaces at the ends, and keeps one spelling
-- per folder. Putting a view in a folder isn't a change to the view: its version stays.
--
-- Existing views get no folder (null).

alter table views
  add column folder text,
  -- Trimmed by the app, 1 to 100 characters, on one line.
  add constraint views_folder_length check (char_length(folder) between 1 and 100),
  add constraint views_folder_one_line
    check (strpos(folder, chr(10)) = 0 and strpos(folder, chr(13)) = 0);
