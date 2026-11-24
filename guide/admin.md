# The Admin space

For Admins: what each Admin page does. The pages are listed at the top of the Admin space: Models, Properties, Database, Branding and Connected apps.

People and their roles aren't managed here. They come from your organisation's sign-in provider: see [Sign-in and roles](sign-in.md).

## Models

**Admin → Models** lists every model.

- **New model** creates an empty model from a name. Names don't have to be unique.
- **Import file** brings in a JSON Graph Format or ArchiMate file as a new model. See [Import and export](import-and-export.md).
- **Export**, on each row, downloads the model as a JSON Graph Format file.
- **Delete** removes a model, with its views. It can't be undone, so export it first if you may need it.

**Damaged models.** Every model is checked in full whenever it is read. A model that fails the check isn't shown in the model list; Admins see it here, by its id only, under **Damaged models**, and can delete it. The app never changes or removes it by itself.

## Properties

**Admin → Properties** defines the extra properties that elements and relationships have, in two lists. **Element properties** are on every element, such as a cost centre or a lifecycle stage, as text, a choice from a list, or a Reference to other elements. **Relation properties** are on every Relation, such as a tier, as text or a choice. Modellers can't add properties of their own. See [Properties](properties.md).

## Database

**Admin → Database** shows the connection to PostgreSQL: the host, port, database, user, whether TLS is on, the server's version, and how many of the migrations have run. It never shows the password. **Test connection** opens a connection and checks it works.

The connection is set by the host, in `DATABASE_URL`, and can't be changed here. See [Database](database.md).

## Branding

**Admin → Branding** gives the app your organisation's look, for everyone, including the signed-out page:

- **A product title:** shown in the header, on the sign-in page, in the browser tab and as the name of the installed app. Up to 40 characters, on one line, as plain text. Leave it empty to use SimpleArchitecture.
- **A logo:** a PNG, JPEG or WebP image, at most 300 KB and 1024 × 1024 pixels. SVG isn't accepted, because it can carry scripts.
- **A logo for the Dark theme (optional):** the same rules as the logo. The Dark theme shows it; without it, the Dark theme shows the logo. It can be set without a logo, and switching the theme swaps the logo at once.
- **An app icon:** a square PNG of exactly 512 × 512 pixels, at most 300 KB. It is the browser tab's icon, the icon added to a phone's home screen, and the installed app's icon. Some phones crop it to a circle or rounded square, so keep what matters near the middle. Without it, the built-in icon is used everywhere. An app installed before the icon changed may keep its old icon until the device refreshes it.
- **A primary and a secondary colour.** The app adjusts them for each theme, so text stays readable in Light and Dark.
- **Reset to the neutral look** removes the product title, both logos, the app icon and both colours, after you confirm.

The preview shows the header in Light and Dark and the browser tab with your changes before you save. Each change is recorded in the audit trail, by the names of the settings changed only.

Element types, states and status colours never change with branding.

## Connected apps

**Admin → Connected apps** lists the AI agents people have connected (see [Connect an AI agent](connect-an-ai-agent.md)). You can disconnect any person's agents, or all of them. Disconnecting stops the agent at once, and is recorded in the audit trail.
