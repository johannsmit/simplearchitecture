import { SpaceHelpPage } from './HelpPage';
import { Key } from './Keys';

const pointer: [string, string][] = [
  ['Click a card or a list row', 'Selects it: the details panel shows it, the canvas stays'],
  ['Double-click a card, a list row or a catalog row', 'Focuses its element'],
  ['Click a line or its label', 'Opens the relationship in the details panel'],
  ['Point at a label', 'Shows its full text'],
  ['Point at a line showing **Data**', "Shows both data lists in full, with each list's name"],
  ['Drag empty canvas', 'Pans the canvas'],
  ['**Zoom out**, **Zoom in**, **Fit view**', 'Zoom out, zoom in, or fit everything in view'],
  ['Drag a card', 'Moves it'],
  [
    '`Shift`+click or `Ctrl`+click a card',
    'Adds it to the selection (again takes it out); then drag any of them to move them all',
  ],
  ["Drag the grip on a card's right edge", 'Makes the card wider or narrower'],
  ['Point at or select a card, then choose its **×**', 'Removes the card from the canvas'],
  ["A card's related elements pill, then an element", 'Adds that element to the canvas'],
  ['Drag an element list row onto the canvas', 'Adds the element to the canvas'],
  ["On a grouped canvas, drag a box's header", 'Moves the box with all its cards'],
  ['On a grouped canvas, drag elsewhere in a box', 'Pans the canvas'],
  ['Drag the handle between two panels', 'Makes the panels wider or narrower'],
  ['Click a catalog column header', 'Sorts by it; again reverses the order'],
  ["Click a folder's header in the Views list", 'Opens or closes the folder'],
];

/** /help/viewing: reading a model, its canvas, views and catalog. */
export function ViewingHelp() {
  return (
    <SpaceHelpPage
      space="viewing"
      lead="Viewing is for reading: explore models, open views, look things up. Nothing you do there changes a model."
      pointer={pointer}
      doing={
        <>
          <h3>Open a model</h3>
          <p>
            Pick a model in the model picker in the header. The model&apos;s start page lists its
            views; pick an element in the element list, or a view, to start exploring.
          </p>

          <h3>The parts of the screen</h3>
          <ul>
            <li>
              <b>The element list</b>, on the left: every element, grouped by type, with the search
              and the filter at the top, and the <b>Views</b> list and the legend at the bottom.
            </li>
            <li>
              <b>The canvas or the catalog</b>, in the middle. The <b>Canvas | Catalog</b> switch
              above it changes between them.
            </li>
            <li>
              <b>The details panel</b>, on the right: the selected element or relationship.
            </li>
          </ul>
          <p>Drag the handles between the panels to make them wider or narrower.</p>

          <h3>Select and focus</h3>
          <p>
            A single click on a card or a list row selects it: the details panel shows it. A double
            click focuses it: it becomes the centre of the canvas, with what it relates to around
            it. The breadcrumbs above the canvas, and the browser&apos;s Back button, return to the
            elements you focused before. The address names the model and the focused element or
            view, so you can share it as a link.
          </p>

          <h3>The details panel</h3>
          <p>
            For an element, the panel shows its description and properties, with &quot;Not set&quot;
            where there is no value, then its relationships, <b>Referenced by</b>,{' '}
            <b>Used in views</b> and, if it has any, its <b>Custom metadata</b>. A click on another
            element in the panel focuses that element.
          </p>

          <h3>Find an element</h3>
          <p>
            Press <Key name="/" /> or click the search box, and type part of a name: the list and
            the catalog show only the matches. The filter narrows the list by property values. In
            the list, the arrow keys move through the rows, and a letter jumps to the next name that
            starts with it.
          </p>

          <h3>Read the canvas</h3>
          <ul>
            <li>
              <b>Cards</b> are elements, coloured by type. <b>Containers</b> are drawn with the
              cards they contain inside them.
            </li>
            <li>
              <b>Lines</b> are relationships. An arrow shows the direction; marks show the
              architecture state (Target or Deprecate). A line that holds several relationships
              running the same way shows &quot;×N&quot;.
            </li>
            <li>
              <b>Depth</b> sets how many relationship steps the canvas shows: 1, 2 or 3. At most 150
              cards are drawn at a time.
            </li>
            <li>
              The <b>legend</b> explains the types and marks, and holds two switches:{' '}
              <b>Nest contained elements</b> and <b>Show relationships</b>.
            </li>
          </ul>

          <h3>Show Viewpoints and Group by</h3>
          <p>
            <b>Show Viewpoints</b> chooses what the lines show in place of their label, such as the
            architecture state, the identity or the data that flows each way. <b>Group by</b> draws
            the cards in boxes, one for each value of one element property. Both are part of the
            page&apos;s address. Neither moves a card by itself or changes a value.
          </p>

          <h3>Add and remove cards</h3>
          <p>
            Add a card from a card&apos;s related elements pill, by dragging a row from the element
            list onto the canvas, or with <Key name="Shift" /> + <Key name="Enter" /> on the row.
            The <b>×</b> on a card removes it from the canvas; the element stays in the model.
          </p>

          <h3>Arrange cards</h3>
          <p>
            Drag a card to move it, or select several and drag any of them. Drag the grip on its
            right edge to make it wider or narrower. <b>Tidy relations</b> draws every line again
            without moving a card. Outside a view, positions are never saved.
          </p>

          <h3>Views</h3>
          <p>
            A view is a named canvas that is stored. Open one from the <b>Views</b> list or the
            model&apos;s start page; folders group them, and from 9 views on a filter box helps you
            find one. <b>Close view</b> goes to the model&apos;s start page. An element&apos;s{' '}
            <b>Used in views</b> lists every view that holds it. In Viewing you can still move cards
            in a view, but nothing is saved.
          </p>

          <h3>The catalog</h3>
          <p>
            The catalog shows every element of one type in a table, with a tab per type. Click a
            column header to sort by it, and again to reverse the order. <Key name="Enter" /> or a
            double click focuses the row&apos;s element on the canvas.
          </p>
        </>
      }
    />
  );
}
