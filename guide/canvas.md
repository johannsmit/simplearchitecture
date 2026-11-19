# The canvas

For everyone: how to read the canvas, choose what its lines show, and arrange its cards.

## What the canvas shows

The canvas is centred on the **focused element**, with the elements it relates to around it, down to the chosen **depth**: 1, 2 or 3 relationship steps (the **Depth** control, or `1` `2` `3`). Double-click a card, or press `Enter` on it, to focus that element instead. At most 150 cards are drawn at a time.

- **Cards** are elements, coloured by type. A Stakeholder is a yellow circle with its name underneath: a person icon for a Human, a robot icon for an AI Agent.
- **Containers** are elements that contain others (through a Contains relationship). They are drawn with the cards they contain inside them, and the containers around the focused element are always brought onto the canvas. Switch **Nest contained elements** off, in the legend, to draw Contains as lines instead.
- **Lines** are relationships. An arrow shows the direction; a two-way relationship has an arrow at both ends. A Contains drawn as a line ends in a diamond. Marks on a line show its architecture state (Target or Deprecate).
- **Labels:** a line shows its label, or nothing. A line that holds several relationships running the same way shows "×N". A long label ends in "…"; point at it for the full text.

Click a line or its label to open the relationship in the details panel. `Esc` closes it again.

The **legend**, at the bottom of the left panel, explains the element types, the Stakeholder icons and the architecture state marks, and holds two switches:

- **Nest contained elements:** draw containers with their cards inside, or as lines.
- **Show relationships:** off hides every line, with its label and marks; the cards stay where they are. Your browser remembers it. In Modelling, drawing or adding a relationship turns the lines back on.

## Show Viewpoints

**Show Viewpoints**, at the top left of the canvas, chooses what the lines show. A viewpoint is a selection of relationship properties:

- Tick one or more choices: Architecture state, Identity, Identity Context, Data, the properties an Admin defined, and any other custom metadata the model's relationships have.
- Lines then show those values in place of their label. A line with none of them is grayed out, but still lights up when you point at it and opens with a click. Contains lines are never grayed out.
- **Data** shows both of a relationship's data lists, each on its own line, starting with an arrow that points the way that data flows: for example "↓ orders, invoices" above "↑ stock levels". Point at the line for the full text, with each list's name.
- **Clear**, in its header, removes the selection. With nothing selected, lines show their labels again.

A viewpoint never moves a card. It is part of the page's address, so you can share it as a link.

## Adding cards

- **A card's related elements:** a card with related elements that aren't on the canvas shows a small pill. Choose it, and pick an element to add.
- **The element list:** drag a row onto the canvas, or press `Shift` + `Enter` on it.
- **In Modelling:** **New element** can also add an existing element to the canvas (**Add to canvas**).

A card you add goes where you dropped it, or next to the card it came from, at the nearest free spot. It brings the cards it contains, down to the current depth, and its containers. No other card moves. Added cards stay until you focus another element.

## Removing a card

Point at a card, or select it, and choose the small **×** at its top-left corner (or `Tab` to it from the card). The card goes, with its lines and the cards drawn inside it. The element stays in the model. The focused element, and a container it is drawn in, can't be removed.

Outside a view, a removed card stays off until you focus another element or reload the page. To bring it back, add it again as above. In a view, see [Views](views.md).

## Moving and resizing cards

- **Move a card:** drag it, or select it and press `M`, then the arrow keys (`Shift` for bigger steps), and `Enter` to drop it or `Esc` to put it back.
- **Make a card wider or narrower:** drag the grip on its right edge (shown when you point at the card or select it), or use `Alt` + `←` `→` after `M`. Its name wraps and its height follows. Stakeholder circles and containers can't be resized this way.
- A card dropped on top of others pushes them down, out of its way. Inside a container, cards don't push each other.

**Containers fit what they hold.** Drag a card inside a container right or down past its edge, and the container grows to hold it. When you drop the card, the container fits its cards again.

Outside a view, positions and widths are never saved: they last until the canvas is a new one. A [view](views.md) keeps them.

## Layout: Tidy up and Tidy relations

The canvas lays itself out automatically only when it is new: when you open an element or a view, reload the page, change the depth or switch **Nest contained elements**. After that, cards stay where they are.

- **Tidy up** lays the whole canvas out again. It places cards by their relationships: lines point down from the element they start at, with as few crossings as it finds.
- **Tidy relations**, in the menu of the small arrow next to **Tidy up** (or `T`), moves no card. It draws every line again from where the cards are now, including lines moved by hand. It can't be chosen while **Show relationships** is off.

Lines follow the cards: when you move a card, its lines find the shortest right-angled way round the other cards. Where two cards face each other with room between them, the line runs straight.

If the automatic layout fails or takes too long, it stops and the canvas says so. You can go on working: the cards are placed simply, or, after a failed **Tidy up**, stay where they were. Try **Tidy up** again, or show fewer elements.

## Zoom and pan

- Zoom with `+` and `-`. `0` fits everything in view.
- Pan by dragging empty canvas, or with `Shift` + the arrow keys.
- The arrow keys move the selection to the nearest card in that direction.

All canvas keys are in [Keyboard shortcuts](keyboard-shortcuts.md#canvas).
