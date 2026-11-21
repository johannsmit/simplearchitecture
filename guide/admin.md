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

- **A logo:** a PNG, JPEG or WebP image, at most 300 KB and 1024 × 1024 pixels. SVG isn't accepted, because it can carry scripts.
- **A primary and a secondary colour.** The app adjusts them for each theme, so text stays readable in Light and Dark.
- **Reset to the neutral look** removes the colours and the logo, after you confirm.

Element types, states and status colours never change with branding.

## Connected apps

**Admin → Connected apps** lists the AI agents people have connected (see [Connect an AI agent](connect-an-ai-agent.md)). You can disconnect any person's agents, or all of them. Disconnecting stops the agent at once, and is recorded in the audit trail.
