import { spaces, type Space } from '@simplearchitecture/shared';
import { Link } from 'react-router';
import { spaceLabels, useMe } from '../auth';
import { usePageTitle } from '../branding';
import { Icon } from '../icons';
import { spaceIcons } from '../shell/spaceIcons';
import { accessWords } from '../shell/UserMenu';
import { HelpFrame } from './HelpPage';

const spaceLines: Record<Space, string> = {
  viewing:
    'For reading: explore models, open views, look things up. Nothing you do there changes a model.',
  modelling:
    'The same screen with editing on: the details panel becomes a form, and you can draw relationships and change views.',
  admin: 'The pages that manage the installation.',
};

/** /help: a card per space, with the user's access to it, and what each role can do. */
export function HelpIndexPage() {
  const me = useMe();
  usePageTitle('Help');

  return (
    <HelpFrame
      title="Help"
      lead="What you can do in each space, with the mouse and the keyboard. Your role decides which spaces you can use."
    >
      <ul className="help-cards">
        {spaces.map((space) => {
          const allowed = me.spaces.includes(space);
          return (
            <li key={space}>
              <Link className="help-card" to={`/help/${space}`}>
                <Icon name={spaceIcons[space]} />
                <h2>{spaceLabels[space]}</h2>
                <p>{spaceLines[space]}</p>
                {allowed ? (
                  <p className="help-access">
                    <Icon name="check" size="sm" />
                    {accessWords[space]}
                  </p>
                ) : (
                  <p className="help-access no">
                    <Icon name="lock" size="sm" />
                    No access
                  </p>
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      <h2>Roles</h2>
      <p>
        Your organisation gives you your role at its sign-in provider. Each role includes the ones
        above it. Without one of these roles you can&apos;t use the app; ask an administrator.
      </p>
      <div className="table-card help-table-wrap">
        <table className="help-table">
          <caption className="vh">Roles</caption>
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Spaces</th>
              <th scope="col">What you can do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="help-key">Viewer</td>
              <td>Viewing</td>
              <td>Read every model and view</td>
            </tr>
            <tr>
              <td className="help-key">Modeller</td>
              <td>Viewing, Modelling</td>
              <td>Also change elements, relationships and views</td>
            </tr>
            <tr>
              <td className="help-key">Admin</td>
              <td>Viewing, Modelling, Admin</td>
              <td>Also import, export and delete models, and run the Admin pages</td>
            </tr>
          </tbody>
        </table>
      </div>
    </HelpFrame>
  );
}
