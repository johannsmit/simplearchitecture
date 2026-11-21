# Keyboard shortcuts

For everyone, and keyboard users in particular: every key, by the place where it works. On a Mac, use `⌘` where a key says `Ctrl`.

Each key has one row per table. Two keys share a row only when they do opposite things (`↑` `↓`) or the same thing. Keys that type text don't act while you are typing in a field.

## Anywhere in the explorer

| Key | What it does                                                                           |
| --- | -------------------------------------------------------------------------------------- |
| `/` | Moves to the element search: above the element list, or above the table in the catalog |

## Canvas

These keys work when the canvas, not the catalog, is shown. They wait while focus is in **Show Viewpoints** or **Group by**. `N` and `R` work in Modelling only.

| Key              | What it does                                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `↑` `↓` `←` `→`  | Moves the selection to the nearest card in that direction                                                                                                                                                                         |
| `Shift` + arrows | Pans the canvas                                                                                                                                                                                                                   |
| `Enter`          | Focuses the selected card's element; in a view, leaves the view for it                                                                                                                                                            |
| `Esc`            | Cancels a line being drawn, or a bend being dragged, and saves nothing. Otherwise closes the open relationship (the panel goes back to the element), or returns from the cards, **Show Viewpoints** or **Group by** to the canvas |
| `1` `2` `3`      | Sets the depth (not in a view)                                                                                                                                                                                                    |
| `+` (or `=`) `-` | Zooms in or out                                                                                                                                                                                                                   |
| `0`              | Fits everything in view                                                                                                                                                                                                           |
| `M`              | Starts moving the selected card (see the next table)                                                                                                                                                                              |
| `T`              | [Tidy relations](canvas.md#layout-tidy-up-and-tidy-relations): draws every line again; no card moves                                                                                                                              |
| `N`              | Modelling: a new element at the centre of the canvas; in an open view, it is added to the view                                                                                                                                    |
| `R`              | Modelling, on a card: adds a relationship from this element (opens **Add relationship**)                                                                                                                                          |

`Tab` from a card reaches its remove button (×), then its related elements pill.

## Moving and resizing a card (after `M`)

| Key              | What it does                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| Arrows           | Moves the card 8 px                                                                                      |
| `Shift` + arrows | Moves the card 40 px                                                                                     |
| `Alt` + `←` `→`  | Makes the card narrower or wider, 8 px (with `Shift`, 40 px); not on a Stakeholder circle or a container |
| `Enter` or `M`   | Drops the card                                                                                           |
| `Tab`            | Drops the card and moves on (a click elsewhere drops it too)                                             |
| `Esc`            | Cancels: the card goes back, at its width before                                                         |

## Related elements list

The list that a card's related elements pill opens.

| Key          | What it does                   |
| ------------ | ------------------------------ |
| `↑` `↓`      | Moves through the list         |
| `Home` `End` | First or last element          |
| `Enter`      | Adds the element to the canvas |
| `Esc`        | Closes the list                |
| `Tab`        | Closes the list and moves on   |

## Element list

The keys go through the visible rows, elements listed under a container included.

| Key               | What it does                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `↑` `↓`           | Previous or next row                                                                          |
| `Home` `End`      | First or last row                                                                             |
| `→`               | Opens a type group or an element with children; on an open one, moves to its first row        |
| `←`               | Closes an open type group or element; otherwise moves to the parent element or the type group |
| `Enter`           | Focuses the element on the canvas; on a type group, opens or closes it                        |
| `Shift` + `Enter` | Adds the element to the canvas without changing the focus (selects it if it is there already) |
| `Space`           | Selects the element: the details panel shows it, the canvas stays                             |
| `*`               | Opens all type groups                                                                         |
| A letter          | Jumps to the next row whose name starts with it                                               |
| `Esc`             | In the search: clears it                                                                      |

## Filter

The filter next to the element search: first a list of properties, then the values of the one you open.

| Key          | What it does                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------- |
| `↑` `↓`      | Previous or next property, or value. In a property's search box, `↓` goes to the first value |
| `Home` `End` | First or last property                                                                       |
| `→`          | On a property, shows its values                                                              |
| `←`          | On a value, goes back to the properties                                                      |
| `Space`      | On a value, picks it or takes it out of the filter                                           |
| `Esc`        | Closes the filter                                                                            |

## Views list

| Key          | What it does                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `↑` `↓`      | Previous or next row: folders and views (from the filter or the Views header, `↓` goes to the first) |
| `Home` `End` | First or last row                                                                                    |
| `→`          | On a closed folder, opens it; on an open one, goes to its first view                                 |
| `←`          | On an open folder, closes it; on a view in a folder, goes to the folder                              |
| `Enter`      | On a folder, opens or closes it; on a view, opens it                                                 |
| `Space`      | On a folder, opens or closes it                                                                      |
| `F2`         | On a folder, renames it (Modelling)                                                                  |
| `Esc`        | While dragging a view, cancels the drag                                                              |

Moving a view to another folder is by mouse only; there is no key for it.

## Catalog

| Key                             | What it does                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `↑` `↓` `←` `→`                 | Moves to the next cell; the details panel shows the row's element. On the type tabs, `←` `→` show another tab                               |
| `Home` `End`                    | First or last cell in the row. On the type tabs, shows another tab                                                                          |
| `Ctrl` + `Home`, `Ctrl` + `End` | First cell of the first row, or last cell of the last row                                                                                   |
| `Page Up` `Page Down`           | Up or down by a screenful of rows                                                                                                           |
| `Enter`                         | On a column header, sorts by it (again reverses the order). In Viewing, focuses the element on the canvas. In Modelling, edits the cell     |
| `Space`                         | On a column header, sorts by it                                                                                                             |
| `Shift` + `Enter`               | Focuses the row's element on the canvas                                                                                                     |
| A letter                        | Viewing: jumps to the next row whose name starts with it. Modelling: edits the cell, starting with that character (a choice opens its list) |
| `F2`                            | Modelling: edits the cell                                                                                                                   |
| `Delete` or `Backspace`         | Modelling: edits the cell, starting empty                                                                                                   |

## Editing a catalog cell (Modelling)

| Key                    | What it does                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Enter`                | Saves and moves down a row; in a choice list, picks the choice and saves                                     |
| `Tab`, `Shift` + `Tab` | Saves and moves right or left                                                                                |
| `Shift` + `Enter`      | Adds a line (Description, Functions)                                                                         |
| `Esc`                  | Cancels: the cell shows its saved value. In a conflict message, reloads the element to show the latest value |
| `↑` `↓`                | In a choice list, moves through the choices                                                                  |
| `Home` `End`           | In a choice list, moves through the choices                                                                  |
| A letter               | In a choice list, moves through the choices                                                                  |

A click elsewhere saves the open cell. `/` always moves to the search; to start a value with "/", press `Enter` first.

## Forms (Modelling)

The details panel's form for an element or a relationship.

| Key              | What it does                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `Ctrl` + `Enter` | Saves the element or relationship, from anywhere in the form, a text box and From and To included |
| `Esc`            | Asks "Discard changes?" when there are unsaved changes                                            |

`Enter` in a one-line field never saves. In Viewing, `Esc` in a relationship's details goes back to its element.

## New element, New relationship and Add relationship

| Key     | What it does                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------- |
| `Enter` | Creates the element, or adds the relationship. In a search list, picks the highlighted element |
| `Esc`   | Closes without creating or adding; in a search with text, clears the text first                |
| `↑` `↓` | In the **Add relationship** search, moves through the matching elements                        |

## From and To (a relationship's ends)

| Key      | What it does                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Enter`  | On the field, opens the element search. In the search, picks the highlighted element as the new end (it doesn't save; with none highlighted, nothing happens) |
| `Space`  | On the field, opens the element search                                                                                                                        |
| `↑` `↓`  | On the field, `↓` opens the search. In the search, highlights an element; none is highlighted at first                                                        |
| A letter | On the field, opens the search with that letter typed                                                                                                         |
| `Esc`    | In the search, closes it without changing the end; focus goes back to the field                                                                               |
| `Tab`    | In the search, closes it without changing the end; focus moves on                                                                                             |

## Suggestions

In a name or value field that offers suggestions, in a relationship's label after `{`, and in the **Folder** field of **Save as view…**.

| Key              | What it does                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `↑` `↓`          | Opens the suggestions and goes through them; the text stays as typed                                                                                     |
| `Enter` or `Tab` | Takes the highlighted suggestion; with none, keeps what is typed. With the list open, `Enter` never saves (in a catalog cell, either key saves as usual) |
| `Esc`            | Closes the list and keeps the text (in a catalog cell, cancels)                                                                                          |

## Data lists (a Relation's form)

The suggestion keys above, and:

| Key             | What it does                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Enter`         | In the box, adds the highlighted suggestion, or what is typed, as a value (it doesn't save). On a value's ×, removes that value; focus moves to the × that takes its place, the one before it, or the box |
| `Shift` + `Tab` | From the box, moves back to the values' × buttons, which come before it                                                                                                                                   |

## Reference fields

| Key             | What it does                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@`             | At the start of the box, lists all the model's elements; type on to narrow it down. Any other letter searches too |
| `↑` `↓`         | `↓` opens the list; both move through it. With text typed, the first element is highlighted                       |
| `Enter`         | Adds the highlighted element (it doesn't save). On an element's ×, removes it                                     |
| `Backspace`     | In the empty box, removes the last element                                                                        |
| `Esc`           | With the list open, closes it and clears what was typed                                                           |
| `Tab`           | Closes the list and moves on; nothing is added                                                                    |
| `Shift` + `Tab` | From the box, moves back to the elements' × buttons, which come before it                                         |

## Panel resize handles

| Key     | What it does                      |
| ------- | --------------------------------- |
| `←` `→` | Makes the panel narrower or wider |
| `Enter` | Resets the panel's width          |

## Menus and dialogs

The theme menu, the menu of the small arrow next to **Tidy up**, and every dialog.

| Key          | What it does                                        |
| ------------ | --------------------------------------------------- |
| `↑` `↓`      | In a menu, previous or next item                    |
| `Home` `End` | In a menu, first or last item                       |
| `Esc`        | Closes the menu or dialog without changing anything |
| `Tab`        | In a menu, closes it and moves on                   |

## Admin → Properties dialogs

| Key     | What it does                                                                                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Enter` | In Name or Key, creates or saves the property. In an option, adds an option after it. In the delete dialog's name field, deletes the property once the name matches (case ignored) |
| `Esc`   | Closes the dialog without saving                                                                                                                                                   |
| `←` `→` | On Kind, moves between Text and Choice (and Reference, for an element property)                                                                                                    |
