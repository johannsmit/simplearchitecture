-- 009: Information flow is no longer a property of a relationship. The key "informationFlow" goes
-- from every relationship's metadata. Where it was true on a Relation with a label, the label also
-- becomes its Data ("data"), unless it has Data already; the label itself stays. Nothing else
-- changes: id, order, type, ends, direction, label, version and all other metadata stay as they
-- are. One statement over the rows that hold the key, so it suits a model of any size.
-- It can't be undone without a backup. An older API refuses the database afterwards.

update relationships
set metadata = case
    when metadata -> 'informationFlow' = 'true'::jsonb
      and relation = 'Relation'
      and label is not null
      -- Not blank: a character outside JavaScript's trim() set (white space and line terminators).
      and label ~ '[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
      and not (metadata ? 'data')
      then (metadata - 'informationFlow') || jsonb_build_object('data', label)
    else metadata - 'informationFlow'
  end
where jsonb_typeof(metadata) = 'object'
  and metadata ? 'informationFlow';
