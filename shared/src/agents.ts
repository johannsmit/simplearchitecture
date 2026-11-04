/**
 * AI agents (MCP clients) that a user connects, as the consent page and the Connected apps page
 * see them. An agent's name is what it says about itself when it registers: show it as text only.
 * Times are ISO 8601, UTC.
 */

/** Response body of `GET /api/agents/requests/:id`: an agent asking to connect. */
export interface AgentRequest {
  /** The name the agent gave, or null when it gave none. */
  clientName: string | null;
  /** The host the browser goes back to (with the port when it isn't the default). */
  redirectHost: string;
  /** The browser goes back to an app on this computer (a loopback address). */
  loopback: boolean;
  /** When the connection would end if allowed now. */
  connectionEndsAt: string;
}

/** Body of `POST /api/agents/requests/:id`: the user's decision. */
export interface AgentDecision {
  allow: boolean;
}

/** Response body of `POST /api/agents/requests/:id`: where the browser goes next. */
export interface AgentDecisionResult {
  location: string;
}

/** One connection on the Connected apps page. Each Allow is its own connection. */
export interface ConnectedApp {
  id: string;
  clientName: string | null;
  redirectHost: string;
  loopback: boolean;
  connectedAt: string;
  /** Null when it hasn't been used yet. */
  lastUsedAt: string | null;
  expiresAt: string;
}

/** Response body of `GET /api/agents`: the user's own connections, newest first. */
export interface ConnectedAppList {
  apps: ConnectedApp[];
}

/** One connection on Admin → Connected apps: whose it is, by the display name at sign-in. */
export interface AdminConnectedApp extends ConnectedApp {
  userId: string;
  userName: string;
}

/** Response body of `GET /api/admin/agents`: every user's connections, newest first. */
export interface AdminConnectedAppList {
  apps: AdminConnectedApp[];
}

/** Response body of the Admin's "disconnect all" calls: how many connections ended. */
export interface AdminDisconnectResult {
  disconnected: number;
}
