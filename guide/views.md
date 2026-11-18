# Views

A view is a named canvas that is stored: a set of elements and relationships of one model, which anyone who can see the model can open later and see exactly as saved.

## Who can do what

- **Viewers** (and everyone above) list and open every view of a model, in Viewing or Modelling. A view can't be private.
- **Modellers and Admins** save, change, rename and delete views, and put them in folders, in Modelling.
- The server checks the role on every request, whatever the screen shows.

Views are stored in the database, so they need PostgreSQL, as editing does.

## Saving a view

1. In Modelling, focus an element, so the canvas shows it and its neighbours.
2. Open **Views** at the bottom of the element list, and choose **Save as view…**.
3. Give it a name, or keep the element's name, and choose **Save view**. To put it in a folder, pick one under **Folder** (`↓` shows the model's folders) or type a new name; leave it empty for no folder. See [Folders](#folders).

The view holds exactly what the canvas draws: every card, including containers and cards added by hand, and every relationship among them, including each one inside a "×N" line and each Contains drawn as nesting. Cards held back by the 150-card limit aren't drawn, so they aren't saved.

A name has 1 to 200 characters and is unique within the model, ignoring case: "Payments" and "payments" can't both exist. That holds across folders: two views in different folders can't share a name either.

## Opening a view

Open **Views** at the bottom of the element list and pick one, or pick one on the model's start page. The section stays open, and the browser remembers whether it is open. A view's address (`…/models/<model>/views/<view>`) can be copied and shared; swap `/viewing` for `/modelling` to open it in Modelling.

A view opens as it was left: each card where it was put, at the width it was given, and each line on the route you gave it or Tidy up drew, or, after Tidy relations, drawn from its cards (see [Layout](#layout)). The depth, Show Viewpoints and the "Nest contained elements" and "Show relationships" switches (in the legend, at the bottom of the left panel) aren't saved in it, though Show Viewpoints stays in the address. Show relationships off hides every relationship line and leaves the cards in place; the browser remembers it, in a view and outside one, and in Modelling drawing or adding a relationship turns the lines back on. A view has no focused element, no depth and no breadcrumbs, and brings in no containers: a card is drawn inside another only when the view holds both and the Contains between them.

Double-click a card, or press `Enter` on it, to leave the view and explore that element; Back returns to the view. **Close view** goes to the model's start page.

### Used in views

An element's details panel, in Viewing and Modelling, has a **Used in views** section: every view of the model that holds the element, by name, each a link that opens it (the view you are in is marked). It says "In no views" when there are none. It is read again when you add the element to the open view or take it out, and when you save, rename or delete a view.

## Folders

Views can be grouped in folders, one level deep: there are no folders inside folders. A folder is a name on the views in it, so it exists while at least one view is in it: there are no empty folders. Everyone who can open the model sees the folders; only Modellers and Admins change them, in Modelling, and the server checks the role whatever the screen shows.

In the **Views** section, the folders come first, by name, each with its views by name and the number of views; the views without a folder follow. The bar above an open view shows its folder before its name ("Stock › Shelving").

- **Open and close a folder:** click its header, or press `Enter`, `Space`, `→` or `←` on it (the README lists every key of the Views list). Folders start open. Your browser remembers which folders you closed, per model (by a code made from the name, not the name itself). Viewers can close folders too: it changes nothing for anyone else. A closed folder that holds the open view shows the check on its header.
- **Filter** (from 9 views): matches view names and folder names. A matching folder shows open while you filter, without changing what your browser remembers; a folder whose name matches shows all its views.
- **Put a view in a folder when you save it:** use the **Folder** field of **Save as view**. A name that matches an existing folder, ignoring case and spaces at the ends, puts the view in that folder, with the folder's spelling ("stock" goes into "Stock").
- **Move a view later:** drag it, with the mouse, in the Views list:
  - onto a folder's header or any of its views, to put it in that folder (also onto a closed folder, which stays closed);
  - onto a view without a folder, to take it out of its folder (when every view is in a folder, a **No folder** row shows while you drag);
  - onto **New folder…** at the end of the list, which asks for the new folder's name.

  A drag starts once the pointer has moved a few pixels, so a click still opens the view. `Esc`, or letting go anywhere else, cancels it. A folder whose last view is dragged out is gone.

- **Rename a folder:** the pencil on its header (shown when you point at it or Tab to it), or `F2` on the header. The folder is renamed on all its views at once, for everyone, and keeps its open or closed state in your browser. Changing only the case is fine.
- **Names:** 1 to 100 characters. A new folder, or a renamed one, can't take the name of another folder, ignoring case and spaces at the ends: the dialog says "There's already a folder called …" and won't save. Folders are never merged; to put a view in an existing folder, drag it there.

Moving a view is by mouse only: there is no key or button to move a view after it is saved. With the keyboard, you can still choose a view's folder when you save it, and open, close and rename folders.

A folder change isn't a change to the view: it doesn't count as an edit, so someone with the view open can go on changing it without being told someone else changed it.

## Changing a view (Modelling)

Every change is saved at once, one at a time: the bar above the view says "Saving…", then "Saved". There is no Save button.

- **Add to canvas**, dragging a row from the element list onto the canvas, a card's related elements, and a new element made on the canvas add the element to the view, with its relationships to elements already in it.
- A relationship drawn between two cards of the view is added to it.
- The **×** on a card (shown when you point at the card, select it or Tab to it) takes it out of the view, with its relationships (and, with nesting on, the cards drawn inside it).
- Relationships aren't taken out of a view one by one. To hide them all, switch **Show relationships** off in the legend: that is remembered by your browser, not saved in the view.
- **Rename** and **Delete** are on the bar above the view. Deleting a view can't be undone. To put a view in a folder, see [Folders](#folders).

None of these change the model: the elements and relationships stay. If someone else changed the view meanwhile, your change isn't saved, the canvas goes back to what is stored, and **Reload view** shows their version.

A view holds at most 150 elements and 5,000 relationships, and a model at most 500 views.

## Layout

A view keeps its cards where they were put. Only what you do saves the layout, in Modelling, at once:

- moving a card (dragging it, or `M` and the arrow keys, then `Enter`),
- setting a card's width (the grip on its right edge, or `Alt` + `←` `→` in move mode),
- adding a card or taking one off (as above),
- moving a line (see [Moving a line](#moving-a-line)),
- **Tidy up**, which lays the whole view out again and saves that, without asking,
- **Tidy relations** (the arrow next to Tidy up, or `T` on the canvas), which moves no card and draws every line again from where the cards are, lines you moved included, and saves that (see [Tidy relations](#tidy-relations)).

Each of these saves where every card of the view is, as you see them, with the width of each card whose width was set by hand (from 168 pixels up to a safety limit of 20,000; a card can be as wide as the free room beside it when you resize it), and the route of every line you moved or that still runs where the automatic layout put it (after Tidy up, or in a view laid out automatically when it opened). A cancelled move (`Esc`) saves nothing.

Nothing else saves a layout. A view that has never been laid out by hand is laid out automatically when it opens. The automatic layout (also Tidy up) places cards by their relationships alone, inside containers too: each line points down from the element it starts at, where the lines allow, and an element's type sets no row. A card without a saved place (for example one that was in the view before the app saved layouts) goes to a free spot, next to a card it is related to. Switching Nest contained elements, or reloading the page, shows the saved layout again. Neither is saved until you move, resize, add or remove a card, or choose Tidy up or Tidy relations; then the whole layout, those cards included, is saved. In a view opened with its saved layout, every line without a saved route follows its cards, taking the shortest right-angled way round the other cards; Tidy up routes them all again.

Containers fit what they hold: each container is just big enough for the cards inside it, with no empty room on any side. A view opens so, even if it was saved with room in a container: the cards inside move up and left together, the container's corner stays where it was, and nothing is saved until your next change. Tidy up fits them too, so the view opens again as Tidy up drew it. Taking a card out of a container fits it, and moving a card inside a container resizes it. Drag the card (or move it with `M`) right or down past the container's edge and the container grows to hold it; left and up, the card stops at the container's padding. When you drop it, the container fits again, growing or shrinking, and room left on the left or at the top is closed by its cards moving up and left together. Containers inside containers fit from the innermost out. A container that grows on the drop over a card beside it pushes that card straight down, just below it, as a dropped card does; a container that shrinks pulls nothing back up. A line you moved follows the cards a fit moves, its ends still leaving the cards straight out.

In Viewing, and for Viewers, cards can still be moved and resized, to look at the view another way, but nothing is saved: the next time, the view opens as it was saved. The server refuses a layout from anyone but a Modeller or an Admin.

If the automatic layout fails, or takes longer than 30 seconds, Tidy up changes and saves nothing: the cards and lines stay where they were, and the canvas says so until a layout works or the view is opened again. Choose Tidy up to try again. If it happens when a view without a saved layout opens, its cards are placed simply instead, each at a free spot, and nothing is saved until your next change.

If a layout isn't saved (someone else changed the view meanwhile, or the connection failed), the bar says so and the cards stay where you put them. After a lost connection, the next move saves the whole layout again; after someone else's change, **Reload view** shows theirs.

Taking a card out of a view, or deleting its element from the model, drops its saved place: added again, it goes to a free spot.

### Moving a line

In Modelling, in a view, you can move a line to where you want it. Lines run in straight stretches with right angles; the corners between the line's two ends are its **bends**, and you move the line by its bends:

1. Point at the line, or open its relationship. A small square shows on each of its bends.
2. Drag a square. The bend follows the pointer, and the two stretches beside it move with it, so the line keeps its right angles; its other bends stay where they are. An end next to the bend slides along its card's side, staying at least a short way from the side's corners (on a Stakeholder, it slides along the circle), and never turns onto another side. Each end leaves its card straight out, at least a short way, so its arrowhead (or diamond) shows: a bend dragged over the card at an end stops just beside it, and once dragged right past that card, the line's end moves to the card's other side.
3. Let go. The new route is saved at once, with the cards, as a card move is.

While you drag, a bend snaps to line up with the line's other bends and ends, and with the middle of either of its cards (so an end can leave from the middle of its side), when it comes within a few pixels of them. Bends that line up merge when you let go: a line with one bend less, or a Z-shaped line that becomes straight. A line with one corner can be moved by that corner, both its ends sliding. A straight line has no bend to drag; it gets bends again when a card at an end moves out of line, or on Tidy up.

Press `Esc` before you let go to cancel: the line goes back to where it was and nothing is saved. Losing the pointer, or switching to another window, cancels the same way.

Where the squares of two lines lie on top of each other (the line you point at and the open one), the bend nearest the pointer is the one that moves. Dragging a line's stretch, or its label (or its "×N"), pans the canvas and moves no line.

A click on a line, its label or a square still opens its relationship, as before, also when the pointer moves a few pixels (up to 4) between the press and the release, as for a click on a card; a drag never does.

There is no keyboard way to move a bend yet; **Tidy up** routes every line again, and **Tidy relations** (`T`) draws every line again from the cards, without moving one.

The view keeps the route. When you move a card at one end of the line later, the bends you moved stay where you put them, and only the stretch at that end follows the card, keeping the right angles. If the card moves under a stretch next to its end, that stretch is pushed out beside the card (or the end moves to the card's side the line comes from), so the arrowhead still shows. A line that can't keep its ends that way (with too few corners, or cards too close together) is drawn automatically again. Lines without a saved route still follow their cards as before.

**Tidy up** gives every line in the view its automatic route again, dropping every route you gave a line, and saves the cards with every line's new route, so the view opens again (after a reload too, and for a Viewer) with the lines where Tidy up drew them. Tidy up brings a line to a card inside a container in beside the container's name, or from its side just below the name, rather than across it; a view saved before keeps its lines as they were saved until you choose Tidy up. When you then move a card, its lines take the shortest right-angled way round the other cards again and keep no saved route; the other lines keep Tidy up's. Once the view is opened again, a line saved on Tidy up's route keeps it as a line you moved does: when a card at one end moves, only the stretch at that end follows. There is no reset for a single line, and you can't add corners to a line. A line also loses its route, and is drawn automatically again, when its relationship is taken out of the view, deleted from the model, or given another source or target, or reversed (in every view that holds it).

Lines can't be moved on a canvas outside a view, in Viewing, or by a Viewer: they show the view's saved routes, until Tidy relations draws them again from the cards on the screen (nothing is saved there).

### Tidy relations

The small arrow next to **Tidy up** opens a menu with Tidy up and **Tidy relations**; `T` on the canvas (or on a card) chooses Tidy relations too. Tidy relations moves no card: every card keeps its place, its width and its nesting, and the zoom and the open relationship stay. Every line is drawn again from where its cards are now, as a line whose card moved is: the automatic layout's routes and the routes you gave lines are both dropped. A line between two cards that face each other, with room for it, runs straight; lines on one side of a card keep their order, so none cross that didn't. A line into a card inside a container from outside it comes in by the container's side, below its name, rather than across it, unless every way would cross another card. The canvas says "Relations tidied up. No card moved.", or, when a line had a route of its own (moved by you, or saved with the view, as Tidy up's routes are once the view is opened again), "Relations tidied up, including lines moved by hand. No card moved."

In Modelling, in a view, the result is saved at once ("Saving…", then "Saved"), with no route for any line, so the view opens again with the lines drawn the same way from the cards. In Viewing, for a Viewer, and on a canvas outside a view, the lines are drawn again on the screen only. Tidy relations can't be chosen while Show relationships is off, on a canvas with no line, or while the canvas is being laid out. Afterwards, Tidy up can be chosen to lay the view out again.

## When the model changes

Deleting an element or a relationship from the model removes it from every view, without a message. Deleting a model deletes its views.

Changing a relationship's source or target (**Change** on its form, in Modelling) keeps it in every view that holds it: the new end is added to each of those views, and the old end stays. A route you gave its line goes, in every view (also when you reverse it), as it ran between the old ends. The new card has no saved place, so it goes to a free spot when the view opens; in the view you are in, it goes there at once and the layout is saved, as for any added card. This counts as a change to each of those views: someone else with one open is told that someone else changed it, and **Reload view** shows the new end. A view that already holds 150 elements and lacks the new end can't take it, so the change isn't saved; take a card out of that view first.

## Export and import

Views, their layouts and their line routes aren't part of the JGF export, and an imported model starts with no views.

Only a relationship with an id can be in a view. An import (JGF or OEF) gives every relationship without an id a new one; ids in the file are kept. Relationships stored without an id by an earlier version can't be in a view.
