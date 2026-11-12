# Security policy

Quaymaster controls the Docker daemon, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab, then **Report a vulnerability**
(`https://github.com/hadieht/quaymaster/security/advisories/new`).

Include:

- the version or commit,
- how you deployed it (container or native, behind a proxy or not, read-only mode or not),
- steps to reproduce, and what an attacker gains,
- whether you tested against a real instance.

Please test only against your own instance, and with throw-away containers.

## What to expect

This is a volunteer project; there is no service-level agreement. We aim to acknowledge a report within 7 days,
to confirm or reject it within 14 days, and to ship a fix for confirmed issues as soon as practical. We will credit you
in the changelog unless you prefer not to be named. Please allow a reasonable time for a fix before disclosing publicly.

## Supported versions

Only the latest release receives security fixes. The project is at 0.1.0.

## Scope

In scope: authentication, sessions and CSRF, authorization (roles, read-only mode, managed scope, self-protection),
secret redaction and encryption, the update and rollback workflow, command and path injection, the notification
client (SSRF controls), and the container and systemd packaging.

Out of scope, by design:

- Anyone who can reach the Docker socket already has root-equivalent access to the host. Quaymaster does not
  defend against a compromised host or Docker daemon.
- Exposing Quaymaster directly to the internet. It has no two-factor authentication and is not meant to be reachable
  from untrusted networks. Run it on a trusted LAN or behind a VPN, with a TLS reverse proxy.
- Findings that need a malicious admin. Admins can already manage all containers in scope.

Known, documented limitations are listed in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md#known-limitations).
