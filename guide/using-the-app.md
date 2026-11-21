# Using the app

For everyone with a role: how to find your way around SimpleArchitecture, open a model and find an element.

## Signing in and your role

You sign in with your organisation's usual sign-in. SimpleArchitecture keeps no passwords of its own. What you can do depends on your role, which your organisation gives you at its sign-in provider:

| Role     | Spaces                    | What you can do                                                |
| -------- | ------------------------- | -------------------------------------------------------------- |
| Viewer   | Viewing                   | Read every model and view                                      |
| Modeller | Viewing, Modelling        | Also change elements, relationships and views                  |
| Admin    | Viewing, Modelling, Admin | Also import, export and delete models, and run the Admin pages |

Each role includes the ones above it. Without one of these roles you can't use the app; ask your administrator. The account menu (your name, top right) shows your roles and your access to each space.

You are signed out after 30 minutes without using the app, or 8 hours after you signed in.

## The three spaces

- **Viewing** is for reading: explore models, open views, look things up. Nothing you do there changes a model.
- **Modelling** is the same screen with editing on: the details panel becomes a form, and you can draw relationships and change views. See [Modelling](modelling.md).
- **Admin** holds the pages that manage the installation. See [The Admin space](admin.md).

## Opening a model

Pick a model in the model picker in the header. It opens in the space you are in. The model's start page lists its views; pick an element in the element list, or a view, to start exploring.

## The parts of the screen

- **The element list**, on the left: every element of the model, grouped by type. An element contained by another element of the same type is listed under it. At the top are the search and the filter; at the bottom are the **Views** list and the legend.
- **The canvas or the catalog**, in the middle. The **Canvas | Catalog** switch above it changes between them. See [The canvas](canvas.md).
- **The details panel**, on the right: the selected element or relationship, with its properties and its relationships (see [The details panel](#the-details-panel)).

Drag the handles between the panels to make them wider or narrower, or use the arrow keys on a handle (`Enter` resets it).

## Select and focus

- **A single click** on a card or a list row selects it: the details panel shows it, and the canvas stays as it is.
- **A double click** focuses it: it becomes the centre of the canvas, with what it relates to around it.

The breadcrumbs above the canvas show the elements you focused before, and the browser's Back button returns to them. The address always names the model and the focused element or view, so you can share it as a link.

## The details panel

For an element, the panel shows its description and properties, then its relationships, **Referenced by**, **Used in views** and, if it has any, its **Custom metadata**. A click on another element in the panel, such as the other end of a relationship, focuses that element.

- **Properties** are the standard properties of the element's type, then every property an Admin defined, in name order, with "Not set" where there is no value. See [Properties](properties.md).
- **A Reference property** lists the elements it points to as links, each with its type under its name.
- **Referenced by** lists the elements that point to this one in a Reference property, with the properties they do so in. It shows only when there are any.
- **Custom metadata** is folded away. It holds only values the element's properties don't cover, such as a standard property its type no longer has, marked **Was a property**.

References are set in Modelling: see [Reference properties](modelling.md#reference-properties).

## Finding an element

- **Search:** press `/` or click the search box, and type part of a name. The list, and the catalog, show only the matches. `Esc` clears the search.
- **Filter:** narrow the list by property values, such as an Owning team, or a Stakeholder's Kind.
- **The keyboard:** the arrow keys move through the list, and typing a letter jumps to the next name that starts with it. See [Keyboard shortcuts](keyboard-shortcuts.md#element-list).

## The catalog

The catalog shows every element of one type in a table, with a tab per type and a column per property. The search and the filter work here too. Click a column header to sort by it, and again to reverse the order.

- In Viewing, `Enter` or a double click focuses the row's element on the canvas.
- In Modelling, you can edit a cell in place: double-click it, or start typing. `Enter` saves it. A Reference, and a value that doesn't fit its property, are changed in the details panel instead.
- In Modelling, **Download CSV**, at the end of the search row, saves the current tab as a CSV file, with the rows as the search, the filter and the sort show them. Cells that a spreadsheet could run as a formula are written so that it shows them as text.

## The header

- **The theme button** (sun or moon) switches between Light, the default, and Dark. Your browser remembers the choice.
- **The account menu** shows your roles and access, **Connected apps** (your AI agents, see [Connect an AI agent](connect-an-ai-agent.md)), the third-party licences, **Sign out** and the version you are using.

## Browsers

SimpleArchitecture is for desktop and laptop browsers, used with a mouse and keyboard, at widths from 1024 pixels. Phones and tablets aren't supported.
