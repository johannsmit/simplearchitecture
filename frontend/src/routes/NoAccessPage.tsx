import { requiredRoleForSpace, type Space } from '@simplearchitecture/shared';
import { Link } from 'react-router';
import { roleLabel, spaceLabels, useMe } from '../auth';
import { Icon } from '../icons';

/**
 * Shown in place of a space the user can't use (e.g. a shared /admin link), or on the start
 * page when the user has no role at all. Loads no data.
 */
export function NoAccessPage({ space }: { space?: Space }) {
  const me = useMe();
  const role = roleLabel(me);
  const alternative = me.spaces[0];

  return (
    <main id="content" tabIndex={-1} className="app-message">
      <section className="message-card no-access">
        <Icon name="lock" />
        <h1>
          {space ? `You don't have access to ${spaceLabels[space]}` : "You don't have access yet"}
        </h1>
        {space ? (
          <p>
            {spaceLabels[space]} is for people with the {requiredRoleForSpace[space]} role
            {space === 'admin' ? '' : ' or higher'}. You&apos;re signed in as {me.name} ({role}).
          </p>
        ) : (
          <p>
            You&apos;re signed in as {me.name}, but you don&apos;t have a role in SimpleArchitecture
            yet.
          </p>
        )}
        <p>
          {space
            ? `Ask an administrator to give you the ${requiredRoleForSpace[space]} role if you need access.`
            : 'Ask an administrator to give you the Viewer, Modeller or Admin role.'}
        </p>
        {alternative && (
          <Link className="btn primary" to={`/${alternative}`}>
            Go to {spaceLabels[alternative]}
          </Link>
        )}
      </section>
    </main>
  );
}
