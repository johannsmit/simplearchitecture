-- 017: a card's width set by hand in a view may be far wider than before. The widest is now a
-- safety cap far above any real card (20000 pixels), so one stored value can't make a card, and the
-- canvas, absurdly large. The smallest stays 168. Every width already stored is within the new
-- bounds and is kept as it is.

alter table view_elements
  drop constraint view_elements_width_bounds,
  add constraint view_elements_width_bounds check (width between 168 and 20000);
