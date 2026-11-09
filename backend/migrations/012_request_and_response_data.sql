-- 012: Data becomes two properties, Request Data and Response Data. On every relationship (a
-- Contains keeps it as a warning, as it kept Data), the key "data" becomes "requestData" with the
-- same value, unless "requestData" is there already: then both stay as they are. Response Data
-- starts empty. In every label, each {Data} becomes {Request Data}: any case, with white space
-- inside the braces; {{ and }} are literal braces, so {{Data}} stays as it is. The label is read in
-- pieces the way the app fills it in: {{, }}, {Data}, text without braces, a lone brace. Nothing
-- else changes: id, order, type, ends, direction, version and all other metadata stay as they are.
-- Set-based, over the rows that hold Data or {Data} only, so it suits a model of any size.
-- It can't be undone without a backup. An older API refuses the database afterwards.

update relationships
set metadata = (metadata - 'data') || jsonb_build_object('requestData', metadata -> 'data')
where jsonb_typeof(metadata) = 'object'
  and metadata ? 'data'
  and not (metadata ? 'requestData');

-- White space as JavaScript's \s: the same set the app ignores around a name.
update relationships
set label = (
  select string_agg(
      case
        when piece[1] ~ '^\{[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[Dd][Aa][Tt][Aa][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*\}$'
          then '{Request Data}'
        else piece[1]
      end,
      '' order by at)
  from regexp_matches(
      label,
      '\{\{|\}\}|\{[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[Dd][Aa][Tt][Aa][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*\}|[^{}]+|[{}]',
      'g') with ordinality as pieces(piece, at)
)
where label ~ '\{[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[Dd][Aa][Tt][Aa][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*\}';
