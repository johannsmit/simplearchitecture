-- 018: the two lists of data are named by direction. On every relationship (a Contains keeps them
-- as a warning, as it did before), the key "requestData" becomes "sourceToTargetData" and
-- "responseData" becomes "targetToSourceData", each with its value exactly as stored, unless the
-- relationship has that new key already: then both stay as they are (the older one a warning, as
-- Data kept beside Request Data is). In every label, each {Request Data} becomes
-- {Source to Target Data} and each {Response Data} becomes {Target to Source Data}: any case, with
-- white space inside the braces (one run or more between the two words); {{ and }} are literal
-- braces, so {{Request Data}} stays as it is. The label is read in pieces the way the app fills it
-- in: {{, }}, a name to rename, text without braces, a lone brace. Nothing else changes: id, order,
-- type, ends, direction, version and all other metadata stay as they are.
-- Set-based, over the rows that hold an older key or name only, so it suits a model of any size.
-- It can't be undone without a backup. An older API refuses the database afterwards.

update relationships
set metadata = (metadata - 'requestData')
  || jsonb_build_object('sourceToTargetData', metadata -> 'requestData')
where jsonb_typeof(metadata) = 'object'
  and metadata ? 'requestData'
  and not (metadata ? 'sourceToTargetData');

update relationships
set metadata = (metadata - 'responseData')
  || jsonb_build_object('targetToSourceData', metadata -> 'responseData')
where jsonb_typeof(metadata) = 'object'
  and metadata ? 'responseData'
  and not (metadata ? 'targetToSourceData');

-- White space as JavaScript's \s: the same set the app ignores in a name.
update relationships
set label = (
  select string_agg(
      case
        when piece[1] ~ '^\{[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[Rr][Ee][Qq][Uu][Ee][Ss][Tt][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+[Dd][Aa][Tt][Aa][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*\}$' then '{Source to Target Data}'
        when piece[1] ~ '^\{[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[Rr][Ee][Ss][Pp][Oo][Nn][Ss][Ee][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+[Dd][Aa][Tt][Aa][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*\}$' then '{Target to Source Data}'
        else piece[1]
      end,
      '' order by at)
  from regexp_matches(
      label,
      '\{\{|\}\}|\{[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[Rr][Ee][Qq][Uu][Ee][Ss][Tt][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+[Dd][Aa][Tt][Aa][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*\}|\{[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[Rr][Ee][Ss][Pp][Oo][Nn][Ss][Ee][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+[Dd][Aa][Tt][Aa][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*\}|[^{}]+|[{}]',
      'g') with ordinality as pieces(piece, at)
)
where label ~ '\{[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[Rr][Ee][Qq][Uu][Ee][Ss][Tt][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+[Dd][Aa][Tt][Aa][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*\}'
   or label ~ '\{[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[Rr][Ee][Ss][Pp][Oo][Nn][Ss][Ee][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+[Dd][Aa][Tt][Aa][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*\}';
