-- 013: Request Data and Response Data become lists of texts. On every relationship (a Contains
-- keeps them as a warning, as it did before), a single text in "requestData" or "responseData"
-- becomes a list holding that one text, exactly as stored. A blank text (empty, or white space only)
-- held no value, so its key is removed. Any other value (a list already, a number, an object, null)
-- stays as it is, for the app to read or warn about. Nothing else changes: id, order, type, ends,
-- direction, label, version and all other metadata stay as they are.
-- Set-based, over the rows that hold such a text only, so it suits a model of any size.
-- It can't be undone without a backup. An older API refuses the database afterwards.
-- White space is JavaScript's \s: the same set the app ignores around a value.

update relationships
set metadata = jsonb_set(metadata, '{requestData}', jsonb_build_array(metadata -> 'requestData'))
where jsonb_typeof(metadata) = 'object'
  and jsonb_typeof(metadata -> 'requestData') = 'string'
  and (metadata ->> 'requestData') !~ '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$';

-- Only blank texts are left as text: they go.
update relationships
set metadata = metadata - 'requestData'
where jsonb_typeof(metadata) = 'object'
  and jsonb_typeof(metadata -> 'requestData') = 'string';

update relationships
set metadata = jsonb_set(metadata, '{responseData}', jsonb_build_array(metadata -> 'responseData'))
where jsonb_typeof(metadata) = 'object'
  and jsonb_typeof(metadata -> 'responseData') = 'string'
  and (metadata ->> 'responseData') !~ '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$';

-- Only blank texts are left as text: they go.
update relationships
set metadata = metadata - 'responseData'
where jsonb_typeof(metadata) = 'object'
  and jsonb_typeof(metadata -> 'responseData') = 'string';
