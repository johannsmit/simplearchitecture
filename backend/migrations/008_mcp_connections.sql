-- 008: AI agents (MCP clients) connect through the app's own small OAuth server. Registered
-- clients, authorize requests waiting for the user's consent, the one-minute authorization codes,
-- each connection (one sign-in of one user in one client) and its tokens. Request ids, codes and
-- tokens are stored only as SHA-256 hashes, never themselves.

create table mcp_clients (
  -- Random, not secret: public clients only (PKCE), so a client id proves nothing on its own.
  id text primary key,
  name text not null,
  -- The exact redirect URIs the client registered, as a JSON list of texts.
  redirect_uris jsonb not null check (jsonb_typeof(redirect_uris) = 'array'),
  created_at timestamptz not null,
  -- Registered, or last given tokens. A client with no connection unused for 30 days is removed.
  last_used_at timestamptz not null
);

create index mcp_clients_last_used_at on mcp_clients (last_used_at);

-- One sign-in of one user in one client. It ends 7 days after the sign-in, however often it
-- refreshes. The roles are those of the user's browser session when they allowed it.
create table mcp_connections (
  id uuid primary key,
  client_id text not null references mcp_clients (id) on delete cascade,
  user_id text not null,
  -- The display name at sign-in, for Admin → Connected apps.
  user_name text not null,
  user_roles jsonb not null check (jsonb_typeof(user_roles) = 'array'),
  -- The MCP endpoint's address the tokens are for (the app's address when they were issued).
  resource text not null,
  -- Where the browser went back to when the user allowed it: the host the list shows.
  redirect_uri text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  last_used_at timestamptz
);

create index mcp_connections_user on mcp_connections (user_id, created_at);
create index mcp_connections_client on mcp_connections (client_id);
create index mcp_connections_expires_at on mcp_connections (expires_at);

-- An authorize request held for the consent page, under a random id (stored hashed): read by the
-- page, then used once by the user's decision, within 10 minutes. The first signed-in user to open
-- it holds it: nobody else can see or decide it.
create table mcp_authorization_requests (
  hash text primary key,
  user_id text,
  client_id text not null references mcp_clients (id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  state text,
  resource text not null,
  expires_at timestamptz not null
);

create index mcp_authorization_requests_expires_at on mcp_authorization_requests (expires_at);

-- Authorization codes: used once, within a minute. A used code is kept for an hour after that, so
-- a second use ends the connection the first one started.
create table mcp_codes (
  hash text primary key,
  client_id text not null references mcp_clients (id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  resource text not null,
  user_id text not null,
  user_name text not null,
  user_roles jsonb not null check (jsonb_typeof(user_roles) = 'array'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  connection_id uuid references mcp_connections (id) on delete set null
);

create index mcp_codes_expires_at on mcp_codes (expires_at);

-- Access tokens (1 hour) and refresh tokens (rotated on every use). A used refresh token is kept
-- until its connection ends, so presenting it again is noticed and ends the connection.
create table mcp_tokens (
  hash text primary key,
  connection_id uuid not null references mcp_connections (id) on delete cascade,
  kind text not null check (kind in ('access', 'refresh')),
  expires_at timestamptz not null,
  used_at timestamptz
);

create index mcp_tokens_connection on mcp_tokens (connection_id);
create index mcp_tokens_expires_at on mcp_tokens (expires_at);
