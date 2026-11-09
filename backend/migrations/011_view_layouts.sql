-- 011: view layouts. Each card of a view can keep where it was left on the canvas: its top left
-- corner (x, y, in canvas pixels, also for a card drawn inside a container) and, when its width
-- was set by hand, that width. A card without a position is placed by the canvas when the view
-- opens. Nothing else about the canvas is stored.
--
-- The layout lives on the card's own row, so taking a card out of a view, deleting its element
-- from the model, or deleting the view or the model removes its position too. Existing cards get
-- no position.

alter table view_elements
  add column x double precision,
  add column y double precision,
  add column width integer,
  -- A position is both coordinates or neither; a width only with a position.
  add constraint view_elements_position check ((x is null) = (y is null)),
  add constraint view_elements_width_needs_position check (width is null or x is not null),
  -- Finite and within reach of the canvas (NaN and infinity are outside these bounds).
  add constraint view_elements_position_bounds
    check (x between -1000000 and 1000000 and y between -1000000 and 1000000),
  add constraint view_elements_width_bounds check (width between 168 and 480);
