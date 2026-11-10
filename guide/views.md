# Views

A view is a named canvas that is stored: a set of elements and relationships of one model, which anyone who can see the model can open later and see exactly as saved.

## Who can do what

- **Viewers** (and everyone above) list and open every view of a model, in Viewing or Modelling. A view can't be private.
- **Modellers and Admins** save, change, rename and delete views, in Modelling.
- The server checks the role on every request, whatever the screen shows.

Views are stored in the database, so they need PostgreSQL, as editing does.

## Saving a view

1. In Modelling, focus an element, so the canvas shows it and its neighbours.
2. Open **Views** at the bottom of the element list, and choose **Save as view…**.
3. Give it a name, or keep the element's name, and choose **Save view**.

The view holds exactly what the canvas draws: every card, including containers and cards added by hand, and every relationship among them, including each one inside a "×N" line and each Contains drawn as nesting. Cards held back by the 150-card limit aren't drawn, so they aren't saved.

A name has 1 to 200 characters and is unique within the model, ignoring case: "Payments" and "payments" can't both exist.

## Opening a view

Open **Views** at the bottom of the element list and pick one, or pick one on the model's start page. The section stays open, and the browser remembers whether it is open. A view's address (`…/models/<model>/views/<view>`) can be copied and shared; swap `/viewing` for `/modelling` to open it in Modelling.

A view opens as it was left: each card where it was put, at the width it was given, and each line you moved on the route you gave it (see [Layout](#layout)). The depth, Show Viewpoints and the "Nest contained elements" and "Show relationships" switches (in the legend, at the bottom of the left panel) aren't saved in it, though Show Viewpoints stays in the address. Show relationships off hides every relationship line and leaves the cards in place; the browser remembers it, in a view and outside one, and in Modelling drawing or adding a relationship turns the lines back on. A view has no focused element, no depth and no breadcrumbs, and brings in no containers: a card is drawn inside another only when the view holds both and the Contains between them.

Double-click a card, or press `Enter` on it, to leave the view and explore that element; Back returns to the view. **Close view** goes to the model's start page.

## Changing a view (Modelling)

Every change is saved at once, one at a time: the bar above the view says "Saving…", then "Saved". There is no Save button.

- **Add to canvas**, dragging a row from the element list onto the canvas, a card's related elements, and a new element made on the canvas add the element to the view, with its relationships to elements already in it.
- A relationship drawn between two cards of the view is added to it.
- The **×** on a card (shown when you point at the card, select it or Tab to it) takes it out of the view, with its relationships (and, with nesting on, the cards drawn inside it).
- Relationships aren't taken out of a view one by one. To hide them all, switch **Show relationships** off in the legend: that is remembered by your browser, not saved in the view.
- **Rename** and **Delete** are on the bar above the view. Deleting a view can't be undone.

None of these change the model: the elements and relationships stay. If someone else changed the view meanwhile, your change isn't saved, the canvas goes back to what is stored, and **Reload view** shows their version.

A view holds at most 150 elements and 5,000 relationships, and a model at most 500 views.

## Layout

A view keeps its cards where they were put. Only what you do saves the layout, in Modelling, at once:

- moving a card (dragging it, or `M` and the arrow keys, then `Enter`),
- setting a card's width (the grip on its right edge, or `Alt` + `←` `→` in move mode),
- adding a card or taking one off (as above),
- moving a line (see [Moving a line](#moving-a-line)),
- **Tidy up**, which lays the whole view out again and saves that, without asking.

Each of these saves where every card of the view is, as you see them, with the width of each card whose width was set by hand (168 to 480 pixels), and the route of every line you moved. A cancelled move (`Esc`) saves nothing.

Nothing else saves a layout. A view that has never been laid out by hand is laid out automatically when it opens. A card without a saved place (for example one that was in the view before the app saved layouts) goes to a free spot, next to a card it is related to. Switching Nest contained elements, or reloading the page, shows the saved layout again. Neither is saved until you move, resize, add or remove a card, or choose Tidy up; then the whole layout, those cards included, is saved. In a view opened with its saved layout, every line without a saved route follows its cards, taking the shortest right-angled way round the other cards; Tidy up routes them all again.

In Viewing, and for Viewers, cards can still be moved and resized, to look at the view another way, but nothing is saved: the next time, the view opens as it was saved. The server refuses a layout from anyone but a Modeller or an Admin.

If a layout isn't saved (someone else changed the view meanwhile, or the connection failed), the bar says so and the cards stay where you put them. After a lost connection, the next move saves the whole layout again; after someone else's change, **Reload view** shows theirs.

Taking a card out of a view, or deleting its element from the model, drops its saved place: added again, it goes to a free spot.

### Moving a line

In Modelling, in a view, you can move a line to where you want it. Lines run in straight stretches with right angles; the first and the last stretch are attached to the cards, and every stretch in between can be moved:

1. Point at a middle stretch of the line. The pointer shows the way it moves: left and right for an upright stretch, up and down for a stretch across.
2. Drag it sideways. The stretches beside it grow or shrink, so the line keeps its right angles, and its ends stay on their cards.
3. Let go. The new route is saved at once, with the cards, as a card move is.

Where two lines run close together, the line nearest the pointer is the one that moves: the one a click there would open. A line's label (or its "×N") can sit on a stretch: drag the label to move the line's middle stretch nearest the pointer, so even a short stretch under the label can be moved.

A click on a line or its label without moving it still opens its relationship, as before; a drag never does. A line with no middle stretch (straight, or with one corner) has nothing to move.

The view keeps the route. When you move a card at one end of the line later, the stretches you moved stay where you put them, and only the stretch at that end follows the card, keeping the right angles. Lines without a saved route still follow their cards as before.

**Tidy up** gives every line in the view its automatic route again and saves the cards, dropping every route you gave a line. Only lines you drag keep a route: the others go on following their cards round the other cards, so after a reload a line may take another way than the one Tidy up drew. There is no reset for a single line, and you can't add or remove a line's corners. A line also loses its route, and is drawn automatically again, when its relationship is taken out of the view, deleted from the model, or given another source or target, or reversed (in every view that holds it).

Lines can't be moved on a canvas outside a view, in Viewing, or by a Viewer: they always show the view's saved routes.

## When the model changes

Deleting an element or a relationship from the model removes it from every view, without a message. Deleting a model deletes its views.

Changing a relationship's source or target (**Change** on its form, in Modelling) keeps it in every view that holds it: the new end is added to each of those views, and the old end stays. A route you gave its line goes, in every view (also when you reverse it), as it ran between the old ends. The new card has no saved place, so it goes to a free spot when the view opens; in the view you are in, it goes there at once and the layout is saved, as for any added card. This counts as a change to each of those views: someone else with one open is told that someone else changed it, and **Reload view** shows the new end. A view that already holds 150 elements and lacks the new end can't take it, so the change isn't saved; take a card out of that view first.

## Export and import

Views, their layouts and their line routes aren't part of the JGF export, and an imported model starts with no views.

Only a relationship with an id can be in a view. An import (JGF or OEF) gives every relationship without an id a new one; ids in the file are kept. Relationships stored without an id by an earlier version can't be in a view.
