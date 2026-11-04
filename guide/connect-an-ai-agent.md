# Connect an AI agent

An AI agent such as Claude can read the architecture models you can see in Viewing, so you can ask it questions about them. It can't change, add or delete anything. You sign in as yourself, so the agent has your access and no more.

The app works like other MCP services: you give the agent one address, sign in when it asks, and allow it. There is no client id to set up, and nothing to change at your sign-in provider.

## Before you start

- You need the Viewer role or higher in SimpleArchitecture.
- The address for your agent is `https://<your app's domain>/mcp`. The app shows it, with a Copy button, on **Connected apps** (account menu, top right).

## Claude on claude.ai and Claude Desktop

Claude Desktop and the mobile apps use the connectors you add on claude.ai, so add it once there.

**Your host must let Anthropic's servers reach the app.** claude.ai and Claude Desktop don't call the app from your computer: they call it from Anthropic's servers, from the published range `160.79.104.0/21` ([Anthropic's IP addresses](https://platform.claude.com/docs/en/api/ip-addresses)). So these paths must be reachable from there over https: `/.well-known/` (the OAuth metadata), `/oauth/register`, `/oauth/token` and `/mcp`. Only your browser opens `/oauth/authorize` and the sign-in pages. If the app is reachable only inside your network, use Claude Code instead (below).

On a Free, Pro, Max or Ultra plan:

1. In Claude, go to **Customize** > **Connectors** and click **Add custom connector**.
2. Enter a name (for example SimpleArchitecture) and the address, `https://<your app's domain>/mcp`.
3. If the dialog asks how to sign in, choose **Sign in now**. If it asks for the OAuth client, choose **Register automatically** (the app doesn't support "Use Claude's published identity" yet). Leave the client id and secret empty.
4. Click **Add**, then **Connect**.
5. Your browser opens the app. Sign in if it asks, check the consent page (see below) and click **Allow**.
6. Back in Claude, the connector shows as connected. In a chat, turn it on under **+** > **Connectors** and ask about your models.

On a Team or Enterprise plan, an Owner adds the connector for the organisation under **Organization settings** > **Connectors** (**Add**, then **Custom**, type **Web**), with the same address and settings. Each member then goes to **Customize** > **Connectors**, finds the connector with the **Custom** label, and clicks **Connect**: everyone signs in as themselves.

On the Free plan, you can add one custom connector.

## Claude Code

Claude Code connects from your own computer, so the app only has to be reachable from there.

1. Add the server, in a terminal:

   ```bash
   claude mcp add --transport http simplearchitecture https://<your app's domain>/mcp
   ```

   Add `--scope user` to have it in all your projects.

2. Start Claude Code (`claude`) and run `/mcp`. Pick **simplearchitecture** and choose to authenticate. Or sign in from the terminal: `claude mcp login simplearchitecture`.
3. Your browser opens the app. Sign in if it asks, check the consent page and click **Allow**.
4. The browser says Claude Code is connected; you can close the tab. Ask Claude Code about your models.

## The consent page

Before an agent connects, the app shows who is asking and what the agent may do:

- **Name it gives**: what the agent says it is called. Any app can say anything here, so don't rely on it.
- **Sends you back**: the address your browser returns to. This is checked by the app. For claude.ai and Claude Desktop it is `claude.ai`; for Claude Code it is "an app on this computer".
- What the agent can do: read the models you can see in Viewing, and nothing else.

Click **Allow** only if you started connecting this agent yourself, just now. If not, click **Deny**. (Allow works a second after the page shows, so a stray click can't allow it.)

## What the agent can ask

The agent gets five read-only tools:

- **List models**: the models you can see, with their size.
- **Model summary**: how many elements of each type, and how many relationships.
- **Search elements**: by name, type and properties, 50 at a time.
- **Get element**: one element in full, with what it is inside, what it contains, and its relationships. A Relation comes with its Identity, Identity Context and Data, when set.
- **Get neighbours**: the elements up to three relationship steps away, as on the canvas, with the same details for each relationship.

Model content (names, descriptions, properties) is passed to the agent as data, marked as untrusted, never as instructions. The app logs each call with your user id, the tool and the model, never the content.

## How long it lasts

A connection lasts **7 days from the moment you allowed it**. Then the agent asks you to sign in again. The agent uses the roles you had when you allowed it: if your role is removed, the agent keeps its access until those 7 days are over (or until it is disconnected).

**Signing out of the app in your browser doesn't disconnect your agents.**

## Disconnect

- **In the app:** account menu > **Connected apps** > **Disconnect**. It stops at once. Each time you allowed an agent is its own row, so the same agent can appear twice.
- **In Claude:** remove the connector under **Customize** > **Connectors**. In Claude Code, run `claude mcp logout simplearchitecture` (which also ends the connection in the app), then `claude mcp remove simplearchitecture`.
- **Admins** can end any user's connections, or all of them, under **Admin** > **Connected apps**. Each of those is recorded in the audit trail.

## If something goes wrong

- **"This request isn't valid"**: the request expired (after 10 minutes), was already used, came from an agent the app doesn't know, or wasn't one the app accepts. Connect again from the agent. An agent that registered but never finished signing in is forgotten after an hour: if Claude Code keeps showing this page, choose **Clear authentication** for the server in `/mcp` (or run `claude mcp logout simplearchitecture`) and connect again.
- **"You can't connect an AI agent yet"**: you have no role in SimpleArchitecture. Ask an administrator for the Viewer role or higher.
- **The agent says it isn't authorised or needs to sign in again**: the 7 days are over, or the connection was disconnected. Connect again.
- **claude.ai says it couldn't reach the server, or the sign-in never starts**: Anthropic's servers can't reach the app. Check that the paths above are open to `160.79.104.0/21`.
