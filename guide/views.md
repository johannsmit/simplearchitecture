# Views

A view is a named canvas that is stored: a set of elements and relationships of one model, which anyone who can see the model can open later and see exactly as saved.

## Who can do what

- **Viewers** (and everyone above) list and open every view of a model, in Viewing or Modelling. A view can't be private.
- **Modellers and Admins** save, change, rename and delete views, in Modelling.
- The server checks the role on every request, whatever the screen shows.

Views are stored in the database, so they need PostgreSQL, as editing does.

## Saving a view

1. In Modelling, focus an element, so the canvas shows it and its neighbours.
2. Open **Views**, next to Canvas | Catalog, and choose **Save as view…**.
3. Give it a name, or keep the element's name, and choose **Save view**.

The view holds exactly what the canvas draws: every card, including containers and cards added by hand, and every relationship among them, including each one inside a "×N" line and each Contains drawn as nesting. Cards held back by the 150-card limit aren't drawn, so they aren't saved.

A name has 1 to 200 characters and is unique within the model, ignoring case: "Payments" and "payments" can't both exist.

## Opening a view

Open **Views** and pick one, or pick one on the model's start page. A view's address (`…/models/<model>/views/<view>`) can be copied and shared; swap `/viewing` for `/modelling` to open it in Modelling.

A view is laid out automatically each time it opens. Card positions, the depth, Show Viewpoints and the "Nest contained elements" and "Show lines" switches aren't saved in it, though Show Viewpoints stays in the address. Show lines off hides every relationship line and leaves the cards in place; the browser remembers it, in a view and outside one, and in Modelling drawing or adding a relationship turns the lines back on. A view has no focused element, no depth and no breadcrumbs, and brings in no containers: a card is drawn inside another only when the view holds both and the Contains between them.

Double-click a card, or press `Enter` on it, to leave the view and explore that element; Back returns to the view. **Close view** goes to the model's start page.

## Changing a view (Modelling)

Every change is saved at once, one at a time: the bar above the view says "Saving…", then "Saved". There is no Save button.

- **Add to canvas**, dragging a row from the element list onto the canvas, a card's related elements, and a new element made on the canvas add the element to the view, with its relationships to elements already in it.
- A relationship drawn between two cards of the view is added to it.
- **Remove** takes the selected card out of the view, with its lines (and, with nesting on, the cards drawn inside it). With a relationship open, it takes only that line out.
- **Rename** and **Delete** are on the bar above the view. Deleting a view can't be undone.

None of these change the model: the elements and relationships stay. If someone else changed the view meanwhile, your change isn't saved, the canvas goes back to what is stored, and **Reload view** shows their version.

A view holds at most 150 elements and 5,000 relationships, and a model at most 500 views.

## When the model changes

Deleting an element or a relationship from the model removes it from every view, without a message. Deleting a model deletes its views.

## Export and import

Views aren't part of the JGF export, and an imported model starts with no views.

Only a relationship with an id can be in a view. An import (JGF or OEF) gives every relationship without an id a new one; ids in the file are kept. Relationships stored without an id by an earlier version can't be in a view.
