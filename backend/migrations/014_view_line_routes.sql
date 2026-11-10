-- 014: line routes in views. Each relationship of a view can keep the route its line was given by
-- hand: the points of the line on the canvas, from the source's end to the target's end, in canvas
-- pixels (route_x holds their x, route_y their y, in order). A line without a route is drawn
-- automatically when the view opens. Nothing else about the lines is stored.
--
-- The route lives on the relationship's own row in the view, so taking the relationship out of the
-- view, deleting it from the model, or deleting the view or the model removes its route too. The
-- app drops it when the relationship gets other ends. Existing relationships get no route.

alter table view_relationships
  add column route_x double precision[],
  add column route_y double precision[],
  -- A route is both lists or neither.
  add constraint view_relationships_route_pairs check ((route_x is null) = (route_y is null)),
  -- One point per x and y: from 2 points (a straight line) to 32 (30 bends), none missing.
  add constraint view_relationships_route_points check (
    route_x is null or (
      array_ndims(route_x) = 1 and array_ndims(route_y) = 1
      and cardinality(route_x) = cardinality(route_y)
      and cardinality(route_x) between 2 and 32
      and array_position(route_x, null) is null
      and array_position(route_y, null) is null)),
  -- Finite and within reach of the canvas, as card positions are (NaN and infinity are outside).
  add constraint view_relationships_route_bounds check (
    -1000000 <= all (route_x) and 1000000 >= all (route_x)
    and -1000000 <= all (route_y) and 1000000 >= all (route_y));
