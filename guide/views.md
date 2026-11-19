# Views

For everyone, and for Modellers who make and change views: a view is a named canvas that is stored. It holds a set of elements and relationships of one model, laid out as you left them, and anyone who can see the model can open it.

## Who can do what

- **Viewers** (and everyone above) open every view of a model, in Viewing or Modelling. A view can't be private.
- **Modellers and Admins** save, change, rename and delete views, and put them in folders, in Modelling.

## Save a view

1. In Modelling, focus an element, so the canvas shows it and what it relates to. Add or remove cards until it shows what you want.
2. Open **Views** at the bottom of the element list, and choose **Save as view…**.
3. Give it a name, choose a folder if you like (see [Folders](#folders)), and choose **Save view**.

The view holds exactly what the canvas draws: every card and every relationship among them, including each one inside a "×N" line. A name is unique within the model, ignoring case, across all folders.

## Open a view

Pick a view in the **Views** list, or on the model's start page. A view's address can be shared as a link.

A view opens as it was left: each card in its place and at its width, and each line on its saved route. The depth, **Show Viewpoints** and the legend's switches aren't saved in a view. A view has no focused element and no depth, and brings in no containers of its own: a card is drawn inside another only when the view holds both.

Double-click a card, or press `Enter` on it, to leave the view and explore that element; Back returns to the view. **Close view** goes to the model's start page.

### Used in views

An element's details panel has a **Used in views** section: every view that holds the element, each a link that opens it.

## Folders

Views can be grouped in folders, one level deep. A folder is a name on the views in it, so there are no empty folders. Everyone sees the folders; only Modellers and Admins change them.

- **Open and close a folder:** click its header. Folders start open, and your browser remembers the ones you closed.
- **Filter:** from 9 views on, a filter box matches view names and folder names.
- **Put a view in a folder when you save it:** use the **Folder** field of **Save as view…**. A name that matches an existing folder, ignoring case, puts the view in that folder.
- **Move a view later:** drag it with the mouse in the Views list, onto a folder (or any view in it), onto a view without a folder to take it out, or onto **New folder…**. `Esc` cancels the drag. There is no keyboard way to move a view after it is saved.
- **Rename a folder:** the pencil on its header, or `F2`. It is renamed on all its views at once, for everyone.

A new or renamed folder can't take the name of another folder: folders are never merged. To put a view in an existing folder, drag it there.

## Change a view (Modelling)

Every change is saved at once: the bar above the view says "Saving…", then "Saved". There is no Save button.

- Adding an element to the canvas (**Add to canvas**, dragging a row from the element list, a card's related elements, or a new element) adds it to the view, with its relationships to the elements already in it. A relationship drawn between two cards of the view is added too.
- The **×** on a card takes it out of the view, with its relationships and the cards drawn inside it.
- Relationships aren't taken out one by one. To hide them all, switch **Show relationships** off in the legend.
- **Rename** and **Delete** are on the bar above the view. Deleting a view can't be undone.

None of this changes the model. If someone else changed the view meanwhile, your change isn't saved, and **Reload view** shows their version.

A view holds at most 150 elements, and a model at most 500 views.

## Layout

A view keeps its cards where they were put. These save the layout at once, in Modelling:

- moving a card, or setting its width;
- adding or removing a card;
- moving a line (see [Moving a line](#moving-a-line));
- **Tidy up**, which lays the whole view out again, without asking;
- **Tidy relations** (see [Tidy relations](#tidy-relations)).

A view never laid out by hand is laid out automatically when it opens, and a card without a saved place goes to a free spot. Neither is saved until your next change.

Containers fit what they hold. A view opens with each container just big enough for its cards.

In Viewing, and for Viewers, you can still move and resize cards to look at the view another way, but nothing is saved.

### Moving a line

In Modelling, in a view, you can move a line by its **bends**, the corners between its two ends:

1. Point at the line, or open its relationship. A small square shows on each bend.
2. Drag a square. The two stretches beside the bend move with it, so the line keeps its right angles. The ends slide along their cards' sides.
3. Let go. The route is saved at once.

While you drag, a bend lines up with the line's other bends and with the middle of either card. Bends that line up merge when you let go, so a line can become straight. `Esc` before you let go puts the line back. Dragging a line's straight stretch or its label pans the canvas instead.

The view keeps the route: when a card at one end moves later, only the stretch at that end follows it. There is no keyboard way to move a bend, no reset for one line, and you can't add corners by hand. A line loses its route when its relationship gets another end or is reversed.

### Tidy relations

**Tidy relations** ([The canvas](canvas.md#layout-tidy-up-and-tidy-relations) says how) draws every line again without moving a card, dropping the routes moved by hand. In a view in Modelling, the result is saved.

## When the model changes

Deleting an element or a relationship from the model removes it from every view. Deleting a model deletes its views.

Changing a relationship's **From** or **To** keeps it in every view that holds it: the new end is added to each of those views, and the old end stays. A view that already holds 150 elements can't take the new end, so that change isn't saved; take a card out of the view first.

Views aren't part of the JSON Graph Format export, and an imported model starts with no views.
