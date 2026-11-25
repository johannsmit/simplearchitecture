# Connect an AI agent

For everyone with a role, and one section for hosts: how to let an AI agent such as Claude read the architecture models you can see, so you can ask it questions about them, and, for Modellers, add and change elements and relationships.

The agent can read what you can see in Viewing. If you are a Modeller or an Admin, it can also add and change elements and relationships, one at a time, with the same rules as Modelling (see [What the agent can change](#what-the-agent-can-change)). It can never delete anything. You sign in as yourself, so the agent has your access and no more.

The app works like other MCP services: you give the agent one address, sign in when it asks, and allow it. There is no client id to set up, and nothing to change at your sign-in provider.

## Before you start

- You need the Viewer role or higher.
- The address for your agent is `https://<your app's domain>/mcp`. The app shows it, with a Copy button, on **Connected apps** (account menu, top right).
- For claude.ai and Claude Desktop, your host must let Anthropic's servers reach the app (see [For hosts](#for-hosts)). If the app is reachable only inside your network, use Claude Code.

## Claude on claude.ai and Claude Desktop

Claude Desktop and the mobile apps use the connectors you add on claude.ai, so add it once there. Claude's screens change from time to time, so yours may differ a little from these steps. On a personal plan:

1. In Claude, go to **Customize** > **Connectors** and click **Add custom connector**.
2. Enter a name (for example SimpleArchitecture) and the address, `https://<your app's domain>/mcp`.
3. If the dialog asks how to sign in, choose **Sign in now**. If it asks for the OAuth client, choose **Register automatically** (the app doesn't support "Use Claude's published identity" yet). Leave the client id and secret empty.
4. Click **Add**, then **Connect**.
5. Your browser opens the app. Sign in if it asks, check the consent page (see below) and click **Allow**.
6. Back in Claude, the connector shows as connected. In a chat, turn it on under **+** > **Connectors** and ask about your models.

On an organisation's plan, an Owner adds the connector for the organisation under **Organization settings** > **Connectors** (**Add**, then **Custom**, type **Web**), with the same address and settings. Each member then goes to **Customize** > **Connectors**, finds the connector with the **Custom** label, and clicks **Connect**: everyone signs in as themselves.

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
- **Sends you back**: the address your browser returns to. The app checks this. For claude.ai and Claude Desktop it is `claude.ai`; for Claude Code it is "an app on this computer".
- What the agent can do: read the models you can see in Viewing. For a Modeller or an Admin, also add and change elements and relationships as you. It can't delete anything.

Click **Allow** only if you started connecting this agent yourself, just now. If not, click **Deny**.

## What the agent can ask

Every agent gets seven read-only tools:

- **List models**: the models you can see, with their size.
- **Model summary**: how many elements of each type, and how many relationships.
- **Search elements**: by name, type and properties, 50 at a time.
- **Get element**: one element in full, with what it is inside, what it contains, and its relationships, each with its `version` (what a change sends back). A Relation comes with its Identity, Identity Context and its two data lists (`sourceToTargetData`, `targetToSourceData`), when set.
- **Get neighbours**: the elements up to three relationship steps away, as on the canvas, with the same details for each relationship.
- **List views**: a model's [views](views.md), by name, with their folder and how many elements and relationships each holds.
- **Get view**: one view's name, folder and Group by, with its elements and its relationships (each with its source and target, and the same details as above), as the model is now. An element or relationship deleted from the model is left out. Where the cards are on the canvas is not included.

Every element comes with its type. A Stakeholder also has its Kind, `stakeholderKind`: `Human` or `AI Agent`, with Human when none is set. So you can ask, for example, which AI agents use an application: the agent searches Stakeholders with the filter `{"stakeholderKind": ["AI Agent"]}`.

An element's properties an Admin defined come by name, under `definedProperties`, in **Search elements** and **Get element**, only those with a value. A Reference comes as the elements it points to, each with its `id` and current `name`. References also come under `references`, by the property's key. **Get element** also lists, under `referencedBy`, the elements that point to this one, each with the key of the property they do so in (`field`).

A relationship's label comes as stored (`label`, which may name properties in braces) and as the canvas shows it (`displayLabel`, with the values filled in). A Relation's properties an Admin defined come by name, under `definedProperties`.

Model content (names, descriptions, properties) is passed to the agent as data, marked as untrusted, never as instructions. The app logs each call with your user id, the tool and the model, never the content.

For an Admin, the agent also gets an eighth read-only tool, **Get logs** (`get_logs`): the app's log lines, as on [Admin → Logs](admin.md#logs). It takes whole days in UTC, `from` and `to` (`YYYY-MM-DD`, both included, today when left out, at most 31 days), and a lowest level, `min_level` (`trace`, `debug`, `info`, `warn`, `error` or `fatal`; `info` when left out). It returns the newest 1,000 lines, newest first, and says when more match. Log lines are passed as untrusted data too. A Modeller's or a Viewer's agent doesn't get it, and the app refuses it for them even if an agent asks.

## What the agent can change

For a Modeller or an Admin, the agent also gets four tools that change a model. A Viewer's agent doesn't get them, and the app refuses them for a Viewer even if an agent asks.

- **Create element**: adds one element, with its type, name, description and properties.
- **Update element**: changes one element's name, type, description or properties. Only what it sends changes.
- **Create relationship**: adds one relationship of a type between two elements of the model, with its Architecture state and description.
- **Update relationship**: changes one relationship: its ends, type, Architecture state, description, label, direction (reverse or two-way), Identity, Identity Context, its two data lists or the properties an Admin defined.

Nothing can be deleted through an agent: delete in [Modelling](modelling.md).

Each change goes through the same checks as Modelling: the same input limits, the metamodel's rules and the whole model's validation. A change that would give the model an error is refused with a message for each field, and nothing is saved. A property an Admin hasn't defined can't be added.

**Preview first.** Every change tool takes `dry_run`. With `dry_run` true, the app checks the change exactly as a save and shows what would be saved, but stores nothing. The tools tell the agent to preview, show you the change, and save only after you confirm. The app can't see your conversation, so read what the agent proposes before you say yes.

**No overwriting.** An update sends the `version` of the element or relationship the agent read. If someone changed it since, the app refuses the change, saves nothing, and tells the agent the current version, so it reads again first.

**Recorded as yours, made by the agent.** A saved change is recorded in the audit trail as yours, like a change you make in Modelling, and also names the agent connection that made it. The name is the one you had when you allowed the agent. A preview isn't recorded.

**Limits.** One element or relationship per call, and at most 60 change calls a minute per user, previews included, on top of the 120 calls a minute for all tools. Over the limit, the agent is told to wait a minute.

## How long it lasts

A connection lasts **7 days from the moment you allowed it**. Then the agent asks you to sign in again. The agent keeps the roles you had when you allowed it: if your role is removed, the agent keeps its access until those 7 days are over, or until it is disconnected.

**Signing out of the app in your browser doesn't disconnect your agents.**

## Disconnect

- **In the app:** account menu → **Connected apps** → **Disconnect**. It stops at once. Each time you allowed an agent is its own row, so the same agent can appear twice.
- **In Claude:** remove the connector under **Customize** > **Connectors**. In Claude Code, run `claude mcp logout simplearchitecture` (which also ends the connection in the app), then `claude mcp remove simplearchitecture`.
- **Admins** can end any user's connections, or all of them, under **Admin → Connected apps**.

## For hosts

claude.ai and Claude Desktop don't call the app from the user's computer: they call it from Anthropic's servers, from the published range `160.79.104.0/21` ([Anthropic's IP addresses](https://platform.claude.com/docs/en/api/ip-addresses)). So these paths must be reachable from there over https:

- `/.well-known/` (the OAuth metadata)
- `/oauth/register`
- `/oauth/token`
- `/mcp`

Only the user's browser opens `/oauth/authorize` and the sign-in pages. If you don't want Anthropic's servers to reach the app, keep those paths closed: Claude Code works from the user's own computer. There is nothing to set up: the app is its own small OAuth server for agents, built from `APP_DOMAIN`. The security rules are in the [security overview](security-overview.md#ai-agents-mcp).

## If something goes wrong

- **"This request isn't valid"**: the request expired (after 10 minutes), was already used, came from an agent the app doesn't know, or wasn't one the app accepts. Connect again from the agent. If Claude Code keeps showing this page, choose **Clear authentication** for the server in `/mcp` (or run `claude mcp logout simplearchitecture`) and connect again.
- **The agent says it can't change the model**: your role, when you allowed it, was Viewer. Ask for the Modeller role, then disconnect and connect again.
- **"You can't connect an AI agent yet"**: you have no role in SimpleArchitecture. Ask an administrator for the Viewer role or higher.
- **The agent says it isn't authorised or needs to sign in again**: the 7 days are over, or the connection was disconnected. Connect again.
- **claude.ai says it couldn't reach the server, or the sign-in never starts**: Anthropic's servers can't reach the app. Check that the paths above are open to `160.79.104.0/21`.
