import { NavLink } from 'react-router';

/** The Admin pages, above each one. */
export function AdminNav() {
  return (
    <nav className="admin-nav" aria-label="Admin pages">
      <ul>
        <li>
          <NavLink to="/admin/models">Models</NavLink>
        </li>
        <li>
          <NavLink to="/admin/database">Database</NavLink>
        </li>
        <li>
          <NavLink to="/admin/branding">Branding</NavLink>
        </li>
        <li>
          <NavLink to="/admin/apps">Connected apps</NavLink>
        </li>
      </ul>
    </nav>
  );
}
