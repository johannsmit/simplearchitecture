# Azure examples

For hosts on Microsoft Azure: one worked example of hosting SimpleArchitecture. Nothing in the app depends on Azure; the general steps are in [Hosting the image](hosting.md) and [Sign-in and roles](sign-in.md).

## Microsoft Entra ID

Use an app registration in your Entra ID tenant as the sign-in provider.

1. Register an application, single tenant. Under **Authentication → Web**, add the redirect URI `https://<APP_DOMAIN>/auth/callback`.
2. Under **App roles**, create three roles, for example `Admin`, `Modeller` and `Viewer`, and assign them to people or groups in **Enterprise applications**.
3. Under **Certificates & secrets**, create a client secret, unless you use a federated credential (below).

The settings are then:

| Variable                                                    | Value                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `OIDC_ISSUER`                                               | `https://login.microsoftonline.com/<tenant id>/v2.0`, with the Directory (tenant) ID |
| `OIDC_CLIENT_ID`                                            | The Application (client) ID                                                          |
| `OIDC_CLIENT_SECRET`                                        | The client secret                                                                    |
| `OIDC_ROLES_CLAIM`                                          | `roles`                                                                              |
| `OIDC_ROLE_ADMIN`, `OIDC_ROLE_MODELLER`, `OIDC_ROLE_VIEWER` | The values of the three app roles                                                    |

## Azure App Service, step by step

With Azure Database for PostgreSQL as the database:

1. **Database:** create the role and the database as in [Database](database.md#1-create-the-role-and-the-database). On the PostgreSQL server, under Networking, allow access from Azure services, or the app's outbound addresses.
2. **The web app:** create it with the container image from `ghcr.io` (see [Pull the image](hosting.md#pull-the-image)).
3. **Port:** under **Deployment Center → Containers**, edit the image and set its **Port** to `8080`. On older web apps without that field, add the app setting `WEBSITES_PORT=8080` instead.
4. **Settings:** under **Settings → Environment variables**, add the ten settings, with `APP_DOMAIN` set to the **Default domain** from the Overview page. Nothing else is needed.
5. **https only:** under **Settings → Configuration → General settings**, set **HTTPS Only** to On.
6. **Entra ID:** in the app registration, add the redirect URI `https://<APP_DOMAIN>/auth/callback`.
7. **Check:** open `https://<APP_DOMAIN>/api/health`; it answers `{"status":"ok"}`. If it doesn't, **Monitoring → Log stream** shows the reason ("API not started …").

Optionally, under **Monitoring → Health check**, set the path to `/api/health`.

## Azure Kubernetes Service with Workload Identity

On AKS with [Azure Workload Identity](https://azure.github.io/azure-workload-identity/), the app can run with no client secret and no database password: it proves itself with the token the platform mounts in the pod.

### Federated credential instead of a client secret

| Variable                     | Value                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `OIDC_CLIENT_AUTH`           | `federated` (unset or `secret`: the client secret, as usual)                                      |
| `AZURE_FEDERATED_TOKEN_FILE` | The token's path. Azure Workload Identity sets it on the pod, so normally there is nothing to add |

`OIDC_CLIENT_SECRET` is then not read. For it to work:

1. The pod has the label `azure.workload.identity/use: "true"` and runs as a service account annotated with `azure.workload.identity/client-id: <OIDC_CLIENT_ID>`.
2. The app registration has a federated credential (**Certificates & secrets → Federated credentials → Kubernetes accessing Azure resources**) with the cluster's OIDC issuer URL, the namespace and the service account's name. The audience stays `api://AzureADTokenExchange`.

The app reads the token file again for every sign-in, because the platform replaces it before it expires.

### Database sign-in with Entra ID instead of a password

Azure Database for PostgreSQL can run with password sign-in turned off. Then set:

| Variable          | Value                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `DATABASE_AUTH`   | `entra` (unset or `password`: the password in `DATABASE_URL`, as usual)                                |
| `DATABASE_URL`    | Without a password: `postgres://<Entra role>@<server>.postgres.database.azure.com:5432/<database>`     |
| `AZURE_CLIENT_ID` | The identity that is the Entra role on the server. Azure Workload Identity sets it from the annotation |

Azure Workload Identity also sets `AZURE_TENANT_ID`, `AZURE_AUTHORITY_HOST` and `AZURE_FEDERATED_TOKEN_FILE`. Create the role on the server for that identity (for example with `pgaadauth_create_principal`) and make it the database's owner, so the migrations can run. The app gets a new token from Entra ID before the old one expires.

If Entra ID gives no token, the app doesn't start, and the log has Entra's error number (for example `AADSTS700213`: no federated credential matches the pod's service account). The database commands and **Admin → Database → Test connection** sign in the same way.
