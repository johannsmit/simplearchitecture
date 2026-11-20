-- 019: Group by in views. A view can be grouped by one element property: the property's key (the
-- element type is "type"), or null for none. Everyone who opens the view sees its cards grouped so.
-- The app checks a new key against the model's properties; a key may stay after no element has it.
--
-- With each card's position, a grouped view keeps the value of the group the card was in when the
-- layout was saved (cut to 200 characters by the app; '' is "Not set"), so a card whose value has
-- changed since is placed afresh when the view opens. Null: saved without grouping.
--
-- Existing views get no Group by and their cards no group: they open as before.

alter table views
  add column group_by text,
  add constraint views_group_by_length check (char_length(group_by) between 1 and 100),
  add constraint views_group_by_not_proto check (group_by <> '__proto__');

alter table view_elements
  add column group_value text,
  -- A group only with a position.
  add constraint view_elements_group_needs_position check (group_value is null or x is not null),
  add constraint view_elements_group_value_length check (char_length(group_value) <= 200);
