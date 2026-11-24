import { Link } from 'react-router';
import { SpaceHelpPage } from './HelpPage';

const pointer: [string, string][] = [
  [
    'Drop a JSON Graph Format or ArchiMate file anywhere on **Admin → Models**',
    'Imports it as a new model',
  ],
  ['Click a column header on **Admin → Models**', 'Sorts the models by it'],
  ["**Export** on a model's row", 'Downloads the model as a JSON Graph Format file'],
  ["**Delete** on a model's row", 'Deletes the model, with its views'],
  ["The pencil on a property's row", 'Edits the property'],
  ["The bin on a property's row", 'Deletes the property, with its values in every model'],
  ["Move up and Move down on a Choice's option", 'Sets the order the form lists the options in'],
  [
    '**+**, or **Add all**, under **In use, not in the list**',
    'Adds a value that is in use to the options, or all of them',
  ],
];

/** /help/admin: the Admin pages. */
export function AdminHelp() {
  return (
    <SpaceHelpPage
      space="admin"
      lead="Admin holds the pages that manage the installation: Models, Properties, Database, Branding and Connected apps."
      pointer={pointer}
      keysIntro={
        <p>
          The keys for menus and dialogs are on the{' '}
          <Link to="/help/viewing#keys-menus-and-dialogs">Viewing help page</Link>.
        </p>
      }
      doing={
        <>
          <h3>People and roles</h3>
          <p>
            People and their roles aren&apos;t managed in the app. They come from your
            organisation&apos;s sign-in provider.
          </p>

          <h3>Models</h3>
          <ul>
            <li>
              <b>New model</b> creates an empty model from a name.
            </li>
            <li>
              <b>Import file</b> brings in a JSON Graph Format file (.json, at most 5 MB) or an
              ArchiMate exchange file (.xml, at most 10 MB) as a new model. The result lists{' '}
              <b>New properties</b>, <b>Property keys changed</b>, <b>References left out</b> and{' '}
              <b>Warnings</b>: check them after the import.
            </li>
            <li>
              <b>Export</b> downloads the model as a JSON Graph Format file, without its views.
              Treat an exported file as confidential: it holds your organisation&apos;s
              architecture.
            </li>
            <li>
              <b>Delete</b> removes a model with its views. It can&apos;t be undone, so export it
              first if you may need it.
            </li>
            <li>
              <b>Damaged models</b> are models that fail the check when they are read. They are
              listed by id only, and you can delete them.
            </li>
          </ul>

          <h3>Properties</h3>
          <p>
            Define the extra properties every element (<b>Element properties</b>) or every Relation
            (<b>Relation properties</b>) has. Each has a <b>Name</b>, a <b>Key</b> and a <b>Kind</b>
            : Text, Choice, or Reference for an element property. Editing keeps the values in the
            models as they are; a value that isn&apos;t one of a choice&apos;s options shows as not
            in the list. Deleting removes the property&apos;s values from every model, once you have
            typed its name, and can&apos;t be undone. Properties added by an import are marked{' '}
            <b>From models</b>: check them.
          </p>

          <h3>Database</h3>
          <p>
            See the connection to the database and how many migrations have run, and check it with{' '}
            <b>Test connection</b>. The connection is set by the host and can&apos;t be changed
            here.
          </p>

          <h3>Branding</h3>
          <p>Give the app your organisation&apos;s look, for everyone:</p>
          <ul>
            <li>a product title of up to 40 characters;</li>
            <li>
              a logo, and a logo for the Dark theme: PNG, JPEG or WebP, at most 300 KB and 1024 ×
              1024 pixels;
            </li>
            <li>an app icon: a square PNG of exactly 512 × 512 pixels, at most 300 KB;</li>
            <li>a primary and a secondary colour, adjusted for each theme.</li>
          </ul>
          <p>
            The preview shows your changes before you save. <b>Reset to the neutral look</b> removes
            them all, after you confirm.
          </p>

          <h3>Connected apps</h3>
          <p>
            See the AI agents people have connected. You can disconnect any person&apos;s agents, or
            all of them; the agent stops at once.
          </p>
        </>
      }
    />
  );
}
