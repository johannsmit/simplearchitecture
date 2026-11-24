import { Link } from 'react-router';
import { SpaceHelpPage } from './HelpPage';
import { Key } from './Keys';

const pointer: [string, string][] = [
  ['Double-click empty canvas', 'Opens **New element** there'],
  ["Drag from a card's handle to another card", 'Creates a relationship between them'],
  [
    "Drag from a card's handle to empty canvas",
    'Opens **New element** there; the relationship follows',
  ],
  [
    'Drag a view in the Views list onto a folder, or onto a view in it',
    'Moves the view into that folder',
  ],
  ['Drag a view onto a view without a folder', 'Takes the view out of its folder'],
  ['Drag a view onto **New folder…**', 'Puts the view in a new folder'],
  ["The pencil on a folder's header", 'Renames the folder, on all its views'],
  ['Point at a line in a view, or open its relationship', 'Shows a small square on each bend'],
  ['Drag a bend square', 'Moves the bend; the line keeps its right angles'],
  ["Drag a line's straight stretch or its label", 'Pans the canvas'],
  ['Double-click a catalog cell', 'Edits it in place'],
  ['The **×** on a chip or a reference', 'Removes that value or element'],
  ['The bin on a value kept as is', 'Removes the value'],
];

/** /help/modelling: creating and changing elements, relationships and views. */
export function ModellingHelp() {
  return (
    <SpaceHelpPage
      space="modelling"
      lead={
        <>
          Modelling is the Viewing screen with editing on. Everything on the{' '}
          <Link to="/help/viewing">Viewing help page</Link> works here too.
        </>
      }
      pointer={pointer}
      keysIntro={<p>These keys come on top of the keys on the Viewing help page.</p>}
      doing={
        <>
          <h3>Create an element</h3>
          <p>
            Choose <b>New element</b> at the top of the element list, type a name, pick a type and
            press <Key name="Enter" />. You can also press <Key name="N" /> on the canvas,
            double-click empty canvas, or draw a line from a card&apos;s handle and drop it on empty
            canvas. If an element with that name exists already, <b>Add to canvas</b> brings that
            one onto the canvas instead. In an open view, a new element is added to the view.
          </p>

          <h3>Change an element</h3>
          <p>
            Select the element and change its fields in the details panel: name, type, description,
            the standard properties of its type and the properties an Admin defined. There is no{' '}
            <b>Add field</b>: an Admin adds properties. Text fields suggest the values the model
            already has. A Stakeholder&apos;s <b>Kind</b> is Human or AI Agent. Changing the type
            keeps every value: a standard property the new type doesn&apos;t have is kept under{' '}
            <b>Custom metadata</b>, marked <b>Was a property</b>.
          </p>

          <h3>Values that don&apos;t fit</h3>
          <p>
            A value that doesn&apos;t fit its property is kept as it is stored, marked{' '}
            <b>Not text</b>, <b>Not a choice</b> or <b>Not a reference</b>, with a bin to remove it.
            A choice whose value isn&apos;t one of its options shows it marked &quot;not in the
            list&quot;.
          </p>

          <h3>Reference properties</h3>
          <p>
            Type <Key name="@" /> in a Reference field to list the model&apos;s elements, or type
            part of a name, and pick one: it is added as a chip. A Reference holds at most 200
            elements, and follows an element when it is renamed.
          </p>

          <h3>Delete an element</h3>
          <p>
            Deleting an element also deletes every relationship from or to it, removes it from every
            view, and takes it out of every Reference that holds it. The elements a deleted
            container held stay in the model.
          </p>

          <h3>Create a relationship</h3>
          <p>
            Drag from a card&apos;s handle to another card. Or select a card and press{' '}
            <Key name="R" />, or choose <b>Add relationship</b> in the details panel, then pick the
            type and the other element. A <b>Relation</b> is any relation between two elements; a{' '}
            <b>Contains</b> draws the target inside the source.
          </p>

          <h3>Change a relationship</h3>
          <p>
            Click the line, or its label, to open its form. <b>From</b> and <b>To</b> are its two
            ends; <b>Reverse direction</b> swaps them. A Relation&apos;s <b>Direction</b> is one-way
            or two-way, and it has an <b>Identity</b>, an <b>Identity Context</b> and two data
            lists. <b>Type</b> and <b>Architecture state</b> can change too.
          </p>

          <h3>Property values in labels</h3>
          <p>
            Write a property&apos;s name in braces in a label, such as {'{Identity}'}, to show its
            value. <b>Shows as</b> previews the result. Write {'{{'} and {'}}'} for a brace itself.
          </p>

          <h3>Rules the app checks</h3>
          <p>
            An element can&apos;t be related to itself, and a Contains can&apos;t make a loop. An
            element may be in two containers, with a warning.
          </p>

          <h3>Saving</h3>
          <p>
            Changes are saved as you go: there is no Save button. The head of the panel says{' '}
            <b>Saving…</b>, then <b>Saved</b>. A field with an error isn&apos;t saved and keeps its
            message. If someone else changed the same element or relationship, choose <b>Reload</b>{' '}
            to see the latest version. You are asked <b>Leave without saving?</b> only when your
            last change couldn&apos;t be saved.
          </p>

          <h3>Views</h3>
          <p>
            Choose <b>Save as view…</b> in the <b>Views</b> list to save what the canvas shows, in a
            folder if you like. Every change to an open view is saved at once. <b>Rename</b> and{' '}
            <b>Delete</b> are on the bar above the view. A view holds at most 150 elements, and a
            model at most 500 views.
          </p>

          <h3>Move a line in a view</h3>
          <p>
            Point at a line, or open its relationship, and drag a square on one of its bends. The
            route is saved when you let go; <Key name="Esc" /> before you let go puts the line back.
          </p>

          <h3>The catalog</h3>
          <p>
            Edit a cell in place: double-click it, or start typing. <Key name="Enter" /> saves it.{' '}
            <b>Download CSV</b> saves the current tab as a CSV file, as the search, the filter and
            the sort show it.
          </p>
        </>
      }
    />
  );
}
