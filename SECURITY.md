# Security policy

## Reporting a vulnerability

Please report a suspected vulnerability privately to **`simplearchitecture@proton.me`**. Don't open a public issue, and don't include real model data or secrets in the report.

Tell me, as far as you can:

- the version (the image tag, for example `1.2.3`) and how it is hosted;
- what an attacker could do, and the steps to reproduce it;
- whether you know of it being used.

## What happens next

SimpleArchitecture is a free tool kept up by one person, so everything here is **best effort**, with no guaranteed response or fix times.

- I read every report, reply as soon as I can, and tell you what I find.
- The most serious issues come first. Fixes ship in a new release.
- I credit you in the release notes if you wish.

Please allow reasonable time for a fix before you tell anyone else about it.

## Supported versions

Only the **latest release** gets security fixes. Upgrade to it to receive them; there are no fixes for older versions.

| Version        | Security fixes |
| -------------- | -------------- |
| Latest release | Yes            |
| Older releases | No             |

## How releases are kept safe

Each release image is scanned for known vulnerabilities on both platforms, web app packages included, and is signed. It ships with a signed SBOM and, from the first release of the public repository on, with GitHub's build provenance attestation. A scan of the latest release runs every week and opens an issue when it finds a fixable high or critical vulnerability. See [guide/security-overview.md](guide/security-overview.md) for how the app protects your data, and the README ("Verify a release") for how to check a release yourself.
