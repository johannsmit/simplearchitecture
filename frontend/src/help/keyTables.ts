import type { Space } from '@simplearchitecture/shared';

/** One row of a keyboard table: the keys as the guide writes them, and what they do. */
export interface KeyRow {
  keys: string;
  does: string;
}

/**
 * A keyboard table on a help page. `guide` names its section in guide/keyboard-shortcuts.md: a
 * test checks that every row there is on the help pages, with the same keys.
 */
export interface KeyTable {
  id: string;
  title: string;
  guide: string;
  before?: string;
  rows: KeyRow[];
  after?: string;
}

const viewing: KeyTable[] = [
  {
    id: 'keys-anywhere',
    title: 'Anywhere in the explorer',
    guide: 'Anywhere in the explorer',
    rows: [
      {
        keys: '`/`',
        does: 'Moves to the element search: above the element list, or above the table in the catalog',
      },
    ],
  },
  {
    id: 'keys-canvas',
    title: 'Canvas',
    guide: 'Canvas',
    before:
      'These keys work when the canvas, not the catalog, is shown. They wait while focus is in **Show Viewpoints** or **Group by**.',
    rows: [
      {
        keys: '`↑` `↓` `←` `→`',
        does: 'Moves the selection to the nearest card in that direction',
      },
      { keys: '`Shift` + arrows', does: 'Pans the canvas' },
      {
        keys: '`Enter`',
        does: "Focuses the selected card's element; in a view, leaves the view for it",
      },
      {
        keys: '`Esc`',
        does: 'Cancels a line being drawn, or a bend being dragged, and saves nothing. Otherwise closes the open relationship (the panel goes back to the element), or returns from the cards, **Show Viewpoints** or **Group by** to the canvas. With several cards selected, keeps only the one in the details panel',
      },
      { keys: '`1` `2` `3`', does: 'Sets the depth (not in a view)' },
      { keys: '`+` (or `=`) `-`', does: 'Zooms in or out' },
      { keys: '`0`', does: 'Fits everything in view' },
      { keys: '`M`', does: 'Starts moving the selected card (see the next table)' },
      { keys: '`T`', does: '**Tidy relations**: draws every line again; no card moves' },
    ],
    after: '`Tab` from a card reaches its remove button (×), then its related elements pill.',
  },
  {
    id: 'keys-moving',
    title: 'Moving and resizing a card (after `M`)',
    guide: 'Moving and resizing a card (after `M`)',
    rows: [
      { keys: 'Arrows', does: 'Moves the card 8 px' },
      { keys: '`Shift` + arrows', does: 'Moves the card 40 px' },
      {
        keys: '`Alt` + `←` `→`',
        does: 'Makes the card narrower or wider, 8 px (with `Shift`, 40 px); not on a Stakeholder circle or a container',
      },
      { keys: '`Enter` or `M`', does: 'Drops the card' },
      { keys: '`Tab`', does: 'Drops the card and moves on (a click elsewhere drops it too)' },
      { keys: '`Esc`', does: 'Cancels: the card goes back, at its width before' },
    ],
  },
  {
    id: 'keys-related',
    title: 'Related elements list',
    guide: 'Related elements list',
    before: "The list that a card's related elements pill opens.",
    rows: [
      { keys: '`↑` `↓`', does: 'Moves through the list' },
      { keys: '`Home` `End`', does: 'First or last element' },
      { keys: '`Enter`', does: 'Adds the element to the canvas' },
      { keys: '`Esc`', does: 'Closes the list' },
      { keys: '`Tab`', does: 'Closes the list and moves on' },
    ],
  },
  {
    id: 'keys-element-list',
    title: 'Element list',
    guide: 'Element list',
    before: 'The keys go through the visible rows, elements listed under a container included.',
    rows: [
      { keys: '`↑` `↓`', does: 'Previous or next row' },
      { keys: '`Home` `End`', does: 'First or last row' },
      {
        keys: '`→`',
        does: 'Opens a type group or an element with children; on an open one, moves to its first row',
      },
      {
        keys: '`←`',
        does: 'Closes an open type group or element; otherwise moves to the parent element or the type group',
      },
      {
        keys: '`Enter`',
        does: 'Focuses the element on the canvas; on a type group, opens or closes it',
      },
      {
        keys: '`Shift` + `Enter`',
        does: 'Adds the element to the canvas without changing the focus (selects it if it is there already)',
      },
      {
        keys: '`Space`',
        does: 'Selects the element: the details panel shows it, the canvas stays',
      },
      { keys: '`*`', does: 'Opens all type groups' },
      { keys: 'A letter', does: 'Jumps to the next row whose name starts with it' },
      { keys: '`Esc`', does: 'In the search: clears it' },
    ],
  },
  {
    id: 'keys-filter',
    title: 'Filter',
    guide: 'Filter',
    before:
      'The filter next to the element search: first a list of properties, then the values of the one you open.',
    rows: [
      {
        keys: '`↑` `↓`',
        does: "Previous or next property, or value. In a property's search box, `↓` goes to the first value",
      },
      { keys: '`Home` `End`', does: 'First or last property' },
      { keys: '`→`', does: 'On a property, shows its values' },
      { keys: '`←`', does: 'On a value, goes back to the properties' },
      { keys: '`Space`', does: 'On a value, picks it or takes it out of the filter' },
      { keys: '`Esc`', does: 'Closes the filter' },
    ],
  },
  {
    id: 'keys-views-list',
    title: 'Views list',
    guide: 'Views list',
    rows: [
      {
        keys: '`↑` `↓`',
        does: 'Previous or next row: folders and views (from the filter or the Views header, `↓` goes to the first)',
      },
      { keys: '`Home` `End`', does: 'First or last row' },
      {
        keys: '`→`',
        does: 'On a closed folder, opens it; on an open one, goes to its first view',
      },
      {
        keys: '`←`',
        does: 'On an open folder, closes it; on a view in a folder, goes to the folder',
      },
      { keys: '`Enter`', does: 'On a folder, opens or closes it; on a view, opens it' },
      { keys: '`Space`', does: 'On a folder, opens or closes it' },
      { keys: '`Esc`', does: 'While dragging a view, cancels the drag' },
    ],
    after: 'Moving a view to another folder is by mouse only; there is no key for it.',
  },
  {
    id: 'keys-catalog',
    title: 'Catalog',
    guide: 'Catalog',
    rows: [
      {
        keys: '`↑` `↓` `←` `→`',
        does: "Moves to the next cell; the details panel shows the row's element. On the type tabs, `←` `→` show another tab",
      },
      {
        keys: '`Home` `End`',
        does: 'First or last cell in the row. On the type tabs, shows another tab',
      },
      {
        keys: '`Ctrl` + `Home`, `Ctrl` + `End`',
        does: 'First cell of the first row, or last cell of the last row',
      },
      { keys: '`Page Up` `Page Down`', does: 'Up or down by a screenful of rows' },
      {
        keys: '`Enter`',
        does: 'On a column header, sorts by it (again reverses the order). Otherwise focuses the element on the canvas',
      },
      { keys: '`Space`', does: 'On a column header, sorts by it' },
      { keys: '`Shift` + `Enter`', does: "Focuses the row's element on the canvas" },
      { keys: 'A letter', does: 'Jumps to the next row whose name starts with it' },
    ],
  },
  {
    id: 'keys-panel-handles',
    title: 'Panel resize handles',
    guide: 'Panel resize handles',
    rows: [
      { keys: '`←` `→`', does: 'Makes the panel narrower or wider' },
      { keys: '`Enter`', does: "Resets the panel's width" },
    ],
  },
  {
    id: 'keys-menus-and-dialogs',
    title: 'Menus and dialogs',
    guide: 'Menus and dialogs',
    before: 'The theme menu, and every dialog.',
    rows: [
      { keys: '`↑` `↓`', does: 'In a menu, previous or next item' },
      { keys: '`Home` `End`', does: 'In a menu, first or last item' },
      { keys: '`Esc`', does: 'Closes the menu or dialog without changing anything' },
      { keys: '`Tab`', does: 'In a menu, closes it and moves on' },
    ],
  },
];

const modelling: KeyTable[] = [
  {
    id: 'keys-canvas',
    title: 'Canvas',
    guide: 'Canvas',
    before:
      'These keys work when the canvas is shown. The other canvas keys are on the Viewing help page.',
    rows: [
      {
        keys: '`N`',
        does: 'A new element at the centre of the canvas; in an open view, it is added to the view',
      },
      {
        keys: '`R`',
        does: 'On a card: adds a relationship from this element (opens **Add relationship**)',
      },
    ],
  },
  {
    id: 'keys-views-list',
    title: 'Views list',
    guide: 'Views list',
    rows: [{ keys: '`F2`', does: 'On a folder, renames it' }],
  },
  {
    id: 'keys-catalog',
    title: 'Catalog',
    guide: 'Catalog',
    rows: [
      {
        keys: '`Enter`',
        does: 'On a column header, sorts by it (again reverses the order). Otherwise edits the cell',
      },
      {
        keys: 'A letter',
        does: 'Edits the cell, starting with that character (a choice opens its list)',
      },
      { keys: '`F2`', does: 'Edits the cell' },
      { keys: '`Delete` or `Backspace`', does: 'Edits the cell, starting empty' },
    ],
  },
  {
    id: 'keys-catalog-cell',
    title: 'Editing a catalog cell',
    guide: 'Editing a catalog cell (Modelling)',
    rows: [
      {
        keys: '`Enter`',
        does: 'Saves and moves down a row; in a choice list, picks the choice and saves',
      },
      { keys: '`Tab`, `Shift` + `Tab`', does: 'Saves and moves right or left' },
      { keys: '`Shift` + `Enter`', does: 'Adds a line (Description, Functions)' },
      {
        keys: '`Esc`',
        does: 'Cancels: the cell shows its saved value. In a conflict message, reloads the element to show the latest value',
      },
      { keys: '`↑` `↓`', does: 'In a choice list, moves through the choices' },
      { keys: '`Home` `End`', does: 'In a choice list, moves through the choices' },
      { keys: 'A letter', does: 'In a choice list, moves through the choices' },
    ],
    after:
      'A click elsewhere saves the open cell. `/` always moves to the search; to start a value with "/", press `Enter` first.',
  },
  {
    id: 'keys-forms',
    title: 'Forms',
    guide: 'Forms (Modelling)',
    before: "The details panel's form for an element or a relationship.",
    rows: [
      {
        keys: '`Ctrl` + `Enter`',
        does: 'Save now: saves a change waiting for the typing pause, from anywhere in the form, a text box and From and To included',
      },
    ],
    after:
      'The form saves as you go. `Enter` in a one-line field never saves, and `Esc` in the form opens no dialog.',
  },
  {
    id: 'keys-new',
    title: 'New element, New relationship and Add relationship',
    guide: 'New element, New relationship and Add relationship',
    rows: [
      {
        keys: '`Enter`',
        does: 'Creates the element, or adds the relationship. In a search list, picks the highlighted element',
      },
      {
        keys: '`Esc`',
        does: 'Closes without creating or adding; in a search with text, clears the text first',
      },
      {
        keys: '`↑` `↓`',
        does: 'In the **Add relationship** search, moves through the matching elements',
      },
    ],
  },
  {
    id: 'keys-from-and-to',
    title: "From and To (a relationship's ends)",
    guide: "From and To (a relationship's ends)",
    rows: [
      {
        keys: '`Enter`',
        does: "On the field, opens the element search. In the search, picks the highlighted element as the new end (it doesn't save; with none highlighted, nothing happens)",
      },
      { keys: '`Space`', does: 'On the field, opens the element search' },
      {
        keys: '`↑` `↓`',
        does: 'On the field, `↓` opens the search. In the search, highlights an element; none is highlighted at first',
      },
      { keys: 'A letter', does: 'On the field, opens the search with that letter typed' },
      {
        keys: '`Esc`',
        does: 'In the search, closes it without changing the end; focus goes back to the field',
      },
      {
        keys: '`Tab`',
        does: 'In the search, closes it without changing the end; focus moves on',
      },
    ],
  },
  {
    id: 'keys-suggestions',
    title: 'Suggestions',
    guide: 'Suggestions',
    before:
      "In a name or value field that offers suggestions, in a relationship's label after `{`, and in the **Folder** field of **Save as view…**.",
    rows: [
      {
        keys: '`↑` `↓`',
        does: 'Opens the suggestions and goes through them; the text stays as typed',
      },
      {
        keys: '`Enter` or `Tab`',
        does: 'Takes the highlighted suggestion; with none, keeps what is typed. With the list open, `Enter` never saves (in a catalog cell, either key saves as usual)',
      },
      {
        keys: '`Esc`',
        does: 'Closes the list and keeps the text (in a catalog cell, cancels)',
      },
    ],
  },
  {
    id: 'keys-data-lists',
    title: "Data lists (a Relation's form)",
    guide: "Data lists (a Relation's form)",
    before: 'The suggestion keys above, and:',
    rows: [
      {
        keys: '`Enter`',
        does: "In the box, adds the highlighted suggestion, or what is typed, as a value (it doesn't save). On a value's ×, removes that value; focus moves to the × that takes its place, the one before it, or the box",
      },
      {
        keys: '`Shift` + `Tab`',
        does: "From the box, moves back to the values' × buttons, which come before it",
      },
    ],
  },
  {
    id: 'keys-reference-fields',
    title: 'Reference fields',
    guide: 'Reference fields',
    rows: [
      {
        keys: '`@`',
        does: "At the start of the box, lists all the model's elements; type on to narrow it down. Any other letter searches too",
      },
      {
        keys: '`↑` `↓`',
        does: '`↓` opens the list; both move through it. With text typed, the first element is highlighted',
      },
      {
        keys: '`Enter`',
        does: "Adds the highlighted element (it doesn't save). On an element's ×, removes it",
      },
      { keys: '`Backspace`', does: 'In the empty box, removes the last element' },
      { keys: '`Esc`', does: 'With the list open, closes it and clears what was typed' },
      { keys: '`Tab`', does: 'Closes the list and moves on; nothing is added' },
      {
        keys: '`Shift` + `Tab`',
        does: "From the box, moves back to the elements' × buttons, which come before it",
      },
    ],
  },
];

const admin: KeyTable[] = [
  {
    id: 'keys-properties-dialogs',
    title: 'Admin → Properties dialogs',
    guide: 'Admin → Properties dialogs',
    rows: [
      {
        keys: '`Enter`',
        does: "In Name or Key, creates or saves the property. In an option, adds an option after it. In the delete dialog's name field, deletes the property once the name matches (case ignored)",
      },
      { keys: '`Esc`', does: 'Closes the dialog without saving' },
      {
        keys: '`←` `→`',
        does: 'On Kind, moves between Text and Choice (and Reference, for an element property)',
      },
    ],
  },
];

/** The keyboard tables of each space's help page, in page order. */
export const keyTables: Record<Space, KeyTable[]> = { viewing, modelling, admin };
