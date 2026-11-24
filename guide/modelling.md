# Modelling: elements and relationships

For Modellers and Admins: how to create and change elements and relationships.

Modelling is the same screen as Viewing, with editing on. The details panel is always a form: there is no Edit button. What the element and relationship types are, and which standard properties each has, is set by the [default metamodel](../metamodel/default-metamodel.md).

## Elements

### Create an element

Choose **New element** at the top of the element list, type a name, pick a type and press `Enter`. You can also:

- press `N` on the canvas, for a new element at its centre;
- double-click empty canvas, for a new element there;
- draw a line from a card's handle and drop it on empty canvas: **New element** opens there, and the relationship follows.

In an open view, a new element is added to the view. If an element with the name you type exists already, **Add to canvas** brings that one onto the canvas instead.

### Change an element

Select the element and change its fields in the details panel: name, type, description, the standard properties of its type, such as Owning team or Architecture state, and the properties an Admin defined.

- **Properties defined by an Admin** come after the type's standard properties and before Functions, in name order, on every element of every type. A Text property is a field, a Choice a list with "Not set" first, and a Reference the `@` field (see [Reference properties](#reference-properties)). The form has no **Add field**: new properties are added by an Admin, on **Admin → Properties**. See [Properties](properties.md).
- **Suggestions:** text fields such as Owning team, Supplier HQ Country and Text properties offer the values the model already has, most used first. Pick one, or type anything else.
- **A Stakeholder's Kind:** Human (a person) or AI Agent (an AI agent acting as a stakeholder). A Stakeholder without a Kind is Human. An AI Agent is drawn with a robot icon wherever its type icon shows.
- **Changing the type** keeps every value. A standard property the new type doesn't have, such as Sourcing when an Application becomes Infrastructure, is kept under **Custom metadata**, marked **Was a property**: the form says which. You can still change its value, or remove it with its bin. Changing back to a type that has the property shows the value in its field again. Properties an Admin defined don't change: every type has them.

### Values that don't fit

A value keeps the shape it was stored with, even when it doesn't fit its property: for example, references kept under a Text property after an upgrade, or after an Admin changed the property's kind.

- **Not text**, **Not a choice** or **Not a reference:** the form shows the value as it is stored, in a box marked "kept as is", with a bin to remove it. Once removed, the property's normal field takes its place. The details panel shows the value with the mark under it, and the catalog shows it read-only.
- **Not in the list:** a choice whose value isn't one of its options shows it as the list's first item, marked "not in the list". It is kept when you save other fields; once you pick another value, only the options and Not set are offered.

### Reference properties

A Reference property points an element at other elements of the same model, without a relationship. It draws no line on the canvas.

- Type `@` in the field's box to list the model's elements, or type part of a name to search them. Pick one with the arrow keys and `Enter`, or click it: it is added as a chip with its type. Remove one with its **×**, or press `Backspace` in the empty box to remove the last one. What you type is only a search and is never saved. All keys are in [Keyboard shortcuts](keyboard-shortcuts.md#reference-fields).
- A Reference holds any element of the model except the element itself, each once, and at most 200. Remove every element to leave it Not set.
- A reference follows the element, not its name: rename the element, and the field shows the new name.
- In the catalog, a Reference shows the elements' names and is changed in the details panel.
- In Viewing, the details panel shows its elements as links. Every element that is referred to lists the elements that refer to it under **Referenced by**, with the property they do so in, in Viewing and Modelling. See [The details panel](using-the-app.md#the-details-panel).

### Delete an element

Deleting an element also deletes every relationship from or to it, removes it from every view, and takes it out of every Reference that holds it (one left with no element becomes Not set). The dialog says how many elements refer to it. The elements a deleted container held stay in the model, no longer nested.

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

- **From** and **To** are its two ends. Choose one to search the model's elements and pick another. The new end is saved as soon as you pick it. A new end that isn't on the canvas joins it at a free spot, and in a view it is added to the view.
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
- A Contains changed between cards already on the canvas shows as a line, or stops nesting, and the cards stay where they are. The nesting is drawn again when the canvas is laid out again: when you open the element or view again, reload the page, or switch **Nest contained elements** off and on.

## Saving

Changes in the details panel are saved as you go. There is no **Save** button.

- **Text fields**, such as Name, Description, Functions, a label or a property's value, are saved when you pause typing for a moment, or when you leave the field. A pause saves once, not every key you type, so the history has one entry per pause.
- **Choices** are saved at once: a type, a list such as Architecture state, a Direction or State, **Reverse direction**, a new **From** or **To**, a suggestion you pick, and a chip you add or remove.
- **Save now:** `Ctrl` + `Enter` (`⌘` + `Enter` on a Mac) anywhere in the form saves a change that is waiting for the pause. `Enter` in a one-line field never saves.
- The head of the panel says **Saving…** while a change is being saved, then **Saved** until your next change. Screen readers hear "Saved" once per save.
- You can keep typing while a change is being saved: what you type meanwhile is saved next, in order.
- **A field with an error**, such as an empty Name, isn't saved: the field keeps its message, and the head says **Couldn't save: 1 field needs a fix**. Your changes to other fields are still saved.
- **When a save fails**, for example when the connection drops, the head says **Couldn't save** and why, the form keeps what you typed, and **Try again** sends it again.
- If someone else changed the same element or relationship after you opened it, your change isn't saved and the form says **Someone else changed this element** (or relationship). Nothing more is saved until you choose **Reload**, which shows the latest version and discards your changes, so copy anything you want to keep first. If they deleted it, the form says so, and you can only close it.
- `Esc` in the form does nothing: there is nothing to discard.
- **Leaving the form**, by picking another element, going back or following a link, first saves a change that is waiting. You are asked **Leave without saving?** only when your last change couldn't be saved. Closing the browser tab warns while a change is waiting, being saved, or couldn't be saved.

**New element** and **Add relationship** still create only when you choose **Create** or **Add**, or press `Enter`. Once created, the element or relationship saves as you go.

All keys for forms are in [Keyboard shortcuts](keyboard-shortcuts.md#forms-modelling).
