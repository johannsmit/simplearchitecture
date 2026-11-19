# Sign-in and roles

For hosts, and whoever manages your organisation's sign-in provider: how to set up sign-in and the three roles.

## How it works

SimpleArchitecture signs people in through one OpenID Connect provider, set only through the settings. It keeps no users or passwords of its own. Who may do what comes from one claim in the ID token, which holds each person's roles or groups.

Any provider works that publishes its discovery metadata over https and can send roles or groups in the ID token, such as Microsoft Entra ID, Okta or Auth0. A provider that can't, such as Google's own sign-in, isn't supported, because the app keeps no roles of its own.

## The roles

| Role     | Can                                                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Viewer   | Read every model and view (Viewing)                                                                                                           |
| Modeller | Also change elements, relationships and views (Modelling)                                                                                     |
| Admin    | Also import, export and delete models, define properties, set the branding, see the database status and disconnect anyone's AI agents (Admin) |

Each role includes the ones above it. A person without any of the three values gets no access.

Roles are read when a person signs in. If you remove a role at the provider, it takes effect at their next sign-in: at most 8 hours later, or 30 minutes after they stop using the app. AI agents a person connected keep the roles they had for up to 7 days (see [Connect an AI agent](connect-an-ai-agent.md)).

## Register the app at your provider

1. **Register a web application** with the authorization code flow, and the redirect address `https://<APP_DOMAIN>/auth/callback`.
2. **`OIDC_ISSUER`:** the `issuer` value from the provider's `/.well-known/openid-configuration`, copied exactly, with or without its trailing slash. If the provider names itself differently, sign-in is refused, with a line in the log. So an address that serves many organisations, such as Entra ID's `/common`, can't be used: it would let in other organisations.
3. **`OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`:** from the registration. The app sends the secret the way the provider says it accepts.
4. **`OIDC_ROLES_CLAIM`:** the name of the claim in the **ID token** that holds the roles or groups, such as `roles` or `groups`. It must be one top-level claim, holding a list or a single text. A nested claim such as `realm_access.roles` isn't supported; a name that is an address (`https://example.com/roles`) is fine. The app asks only for the scopes `openid profile email`, so the provider must include the claim with those.
5. **`OIDC_ROLE_ADMIN`, `OIDC_ROLE_MODELLER`, `OIDC_ROLE_VIEWER`:** the exact values in that claim that give each role, case included. They may contain spaces.

Put the values in the host's settings: see [Hosting the image](hosting.md#settings). For Microsoft Entra ID, the steps are in [Azure examples](azure.md#microsoft-entra-id).

**Warning:** if the claim holds group names, use groups that ordinary users can't create, join or rename. Anyone who can make a group with the name in `OIDC_ROLE_ADMIN` becomes an Admin of this app. Prefer the provider's roles, or fixed group ids, where it has them.

## Sign-out

Sign-out ends the person's session in the app, then sends the browser to the provider's sign-out address, if it has one. Without one, the browser returns to the app's home page and the person stays signed in at the provider. Some providers show their own message instead of signing out; the session in the app has ended either way.

## Moving to another provider

The app knows each person by the `oid` claim if the provider sends one, otherwise by `sub`. If you move an existing installation to another provider, its people get new ids, so the audit trail shows them as new users.
