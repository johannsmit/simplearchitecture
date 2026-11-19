# Modelling: elements and relationships

For Modellers and Admins: how to create and change elements and relationships.

Modelling is the same screen as Viewing, with editing on. The details panel is always a form: there is no Edit button. What the element and relationship types are, and which standard properties each has, is set by the [default metamodel](../metamodel/default-metamodel.md).

## Elements

### Create an element

Choose **New element** at the top of the element list, type a name, pick a type and press `Enter`. You can also:

- press `N` on the canvas, for a new element at its centre;
- double-click empty canvas, for a new element there;
- draw a line from a card's handle and drop it on empty canvas, for **New element here**, with the relationship.

In an open view, a new element is added to the view. If an element with the name you type exists already, **Add to canvas** brings that one onto the canvas instead.

### Change an element

Select the element and change its fields in the details panel: name, type, description and the standard properties of its type, such as Owning team or Architecture state.

- **Custom metadata:** **Add field** adds a property of your own. The name box offers names that other elements of the model use, most used first; you can always type a new one.
- **Suggestions:** text fields such as Owning team, Supplier HQ Country and custom metadata offer the values the model already has, most used first. Pick one, or type anything else.
- **A Stakeholder's Kind:** Human (a person) or AI Agent (an AI agent acting as a stakeholder). A Stakeholder without a Kind is Human. An AI Agent is drawn with a robot icon wherever its type icon shows.
- **Changing the type** keeps every value. Standard properties the new type doesn't have become custom metadata.

### Delete an element

Deleting an element also deletes every relationship from or to it, and removes it from every view. The elements a deleted container held stay in the model, no longer nested.

## Relationships

### Create a relationship

- Drag from a card's handle to another card. Drop it on empty canvas instead to create a new element at the other end.
- Or select a card and press `R`, or choose **Add relationship** in the Relationships section of an element's details panel, then pick the type and the other element.

There are two types:

- **Relation:** any relation between two elements, such as an integration, hosting, or serving a business process. Its label, or its properties, say what kind it is. Several Relations may link the same two elements.
- **Contains:** the target is part of the source, and is drawn inside it on the canvas.

A new relationship runs one way, from the element you started at.

### Change a relationship

Click the line, or its label, to open the relationship's form.

- **From** and **To** are its two ends. Choose one to search the model's elements and pick another. The change is saved with the form, like any other field. When you save, a new end that isn't on the canvas joins it at a free spot, and in a view it is added to the view.
- **Reverse direction** swaps the two ends, and the two data lists with them, so the same data keeps flowing between the same two elements.
- **Direction:** a Relation can be one-way or two-way. A two-way relationship has an arrow at both ends; its From end is the one stored as the source.
- **Type:** changing a Relation to a Contains makes it one-way and removes its Identity, Identity Context and data lists. Values of properties an Admin defined are kept, as custom metadata.
- **Architecture state** and **Description** apply to both types.

Deleting a relationship leaves its two elements as they are.

### A Relation's properties

- **Identity:** the identity used for the exchange, such as a service account.
- **Identity Context:** more context on it, such as the original user's id.
- **Data:** two lists of the data exchanged, named after the ends. For a Relation from Order system to Warehouse they are "Order system to Warehouse" and "Warehouse to Order system". Each value shows as a chip: type a value, or pick one the model already uses, and press `Enter` to add it; choose its **×** to remove it. A list holds at most 50 values, and no value twice (ignoring case).
- **Properties defined by an Admin** follow the data lists. Relationships take no custom metadata of your own: see [Properties](properties.md).

### Property values in labels

A label can show the relationship's own values. Write a property's name in braces: `{Identity}`, or `Sends {Source to Target Data}, gets {Target to Source Data}`.

- The names are the properties the form shows (case doesn't matter), the names of properties an Admin defined, and custom metadata keys. The data lists fill in their values, joined by ", ".
- The canvas and the details panel show the filled-in label. A property with no value fills in nothing. A name the relationship can't have, such as a typo, stays as typed.
- On the form, **Shows as** previews the result, and typing `{` offers the names you can use.
- Write `{{` and `}}` for a brace itself: `{{Identity}}` shows `{Identity}`.

The label is stored as typed, so a JSON Graph Format export keeps the braces.

### Rules the app checks

- An element can't be related to itself.
- A Contains can't make a loop, and the same Contains can't be there twice.
- An element may be in two containers, with a warning. It is drawn inside the first.
- A Contains changed between cards already on the canvas shows as a line, or stops nesting, until you choose Tidy up.

## Saving

- **Save**, or `Ctrl` + `Enter` (`⌘` + `Enter` on a Mac) anywhere in the form, saves the element or relationship. `Enter` in a one-line field never saves.
- `Esc` in the form asks whether to discard your unsaved changes.
- If someone else changed the same element or relationship after you opened it, your save is refused and the form says **Someone else changed this element** (or relationship). Choose **Reload** to see the latest version: this discards your changes, so copy anything you want to keep first. If they deleted it, the form says so, and you can only close it.

All keys for forms are in [Keyboard shortcuts](keyboard-shortcuts.md#forms-modelling).
