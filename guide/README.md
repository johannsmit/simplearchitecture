# SimpleArchitecture guide

Every page of the guide, grouped by who it is for. The [front page](../README.md) says what SimpleArchitecture is and how to run it quickly.

## Using the app

- [Using the app](using-the-app.md): the spaces and roles, opening a model, the parts of the screen, finding elements, the catalog.
- [The canvas](canvas.md): what the canvas shows, Show Viewpoints, Group by, adding, moving and removing cards, Tidy relations.
- [Modelling](modelling.md): creating and changing elements and relationships.
- [Views](views.md): saving, opening, arranging and organising views.
- [Keyboard shortcuts](keyboard-shortcuts.md): every key, in tables.
- [Connect an AI agent](connect-an-ai-agent.md): let Claude or another MCP client read your models, and for Modellers add and change elements and relationships.

## For Admins

- [The Admin space](admin.md): models, properties, branding, the database status and connected apps.
- [Import and export](import-and-export.md): JSON Graph Format and ArchiMate files.
- [Properties](properties.md): the properties an Admin defines for elements and relationships.

## Hosting

- [Run with Docker Compose](docker-compose.md): the quickest way to run it, on one machine.
- [Hosting the image](hosting.md): the image, its settings, the https proxy and upgrades, on any container host.
- [Sign-in and roles](sign-in.md): set up your OpenID Connect provider and the three roles.
- [Azure examples](azure.md): Microsoft Entra ID, Azure App Service and Azure Kubernetes Service.
- [Database](database.md): set up PostgreSQL.

## Security

- [Security overview](security-overview.md): for IT and security teams. What is stored, what the app connects to, how it protects itself, and how to verify a release.
- [SECURITY.md](../SECURITY.md): how to report a vulnerability.

## Development

- [Development](development.md): build and run SimpleArchitecture from source, and how releases are made.

## Reference

- [The default metamodel](../metamodel/default-metamodel.md): the element and relationship types and their standard properties, and the JSON Graph Format template.
- Release notes: what each version brings. Read them before you upgrade.
  - [0.74.1](releases/v0.74.1.md): Admin → Logs shows the right hours when the date range crosses a clock change.
  - [0.74.0](releases/v0.74.0.md): Admins can read the application logs in the Admin space and through the MCP endpoint, for a chosen date range.
  - [0.73.0](releases/v0.73.0.md): AI agents can add and change elements and relationships for Modellers, with a preview and a mark in the audit trail.
  - [0.72.0](releases/v0.72.0.md): Help in the app, with a page per space for what you can do, pointer actions and keyboard shortcuts.
  - [0.71.0](releases/v0.71.0.md): Modelling saves changes in the details panel as you go, with no Save button.
  - [0.70.0](releases/v0.70.0.md): a product title, a logo for the Dark theme and an app icon in Admin → Branding.
  - [0.69.0](releases/v0.69.0.md): lines between cards apart both ways take one corner, into the top of the lower card.
  - [0.68.0](releases/v0.68.0.md): lines take the short way between their cards, and Tidy up is removed.
  - [0.67.1](releases/v0.67.1.md): lines from a card inside a container cross its header beside the name.
  - [0.67.0](releases/v0.67.0.md): lines between cards above and below each other use the facing top and bottom.
  - [0.66.0](releases/v0.66.0.md): select several cards and move them together.
  - [0.65.2](releases/v0.65.2.md): straight lines between a Stakeholder circle and a card.
  - [0.65.0](releases/v0.65.0.md): AI agents can read a model's views.
  - [0.64.0](releases/v0.64.0.md): lines go round the cards in their way.
  - [0.63.0](releases/v0.63.0.md): element properties defined by an Admin.
  - [0.60.0 (beta)](releases/v0.60.0.md): the first public release.
