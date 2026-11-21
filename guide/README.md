# SimpleArchitecture guide

Every page of the guide, grouped by who it is for. The [front page](../README.md) says what SimpleArchitecture is and how to run it quickly.

## Using the app

- [Using the app](using-the-app.md): the spaces and roles, opening a model, the parts of the screen, finding elements, the catalog.
- [The canvas](canvas.md): what the canvas shows, Show Viewpoints, Group by, adding, moving and removing cards, Tidy up.
- [Modelling](modelling.md): creating and changing elements and relationships.
- [Views](views.md): saving, opening, arranging and organising views.
- [Keyboard shortcuts](keyboard-shortcuts.md): every key, in tables.
- [Connect an AI agent](connect-an-ai-agent.md): let Claude or another MCP client read your models.

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
  - [0.64.0](releases/v0.64.0.md): lines go round the cards in their way.
  - [0.63.0](releases/v0.63.0.md): element properties defined by an Admin.
  - [0.60.0 (beta)](releases/v0.60.0.md): the first public release.
