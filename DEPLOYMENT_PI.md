# Raspberry Pi deployment

This supplements [DEPLOYMENT.md](./DEPLOYMENT.md) with Raspberry Pi guidance.
It intentionally contains no real device address, account, bot identity or
credential.

## Recommended layout

Use a 64-bit Raspberry Pi OS release, Node.js 24+, and one unprivileged system
account per bot. A typical two-instance layout is:

```text
/opt/scallopbot-a/             application checkout
/opt/scallopbot-b/             separate application checkout
/var/lib/scallopbot-a/         database and workspace
/var/lib/scallopbot-b/         separate database and workspace
/var/backups/scallopbot-a/     private backups
/var/backups/scallopbot-b/     private backups
```

Keep each instance's `.env`, channel credentials, OAuth data, `HOME`, database
and skills isolated. Do not put any of them under a directory served by Nginx.

## Process and proxy

Run each bot under systemd or PM2 with a distinct process name and dashboard
port. Bind dashboards to `127.0.0.1` unless an authenticated reverse proxy is
configured. If Nginx exposes a dashboard, require TLS and authentication; a
private LAN address alone is not an access-control boundary.

Enable supervisor startup only after both services pass a reboot test. Confirm
that only one process polls each channel token, since duplicate Telegram
pollers, for example, produce conflict errors.

## Resource guidance

- Build serially on lower-memory Pis or build elsewhere for the same ARM64
  runtime and deploy the artifact.
- Keep SQLite and its WAL on reliable local storage, not a flaky network share.
- Reserve space for backups and configure log rotation.
- A local embedding server may be shared, but set memory limits and health
  checks so it cannot starve the chat processes.
- Use an RTC/NTP service. Deterministic dates and scheduled work depend on a
  correct system clock and configured timezone.

## Update sequence

For each instance separately: make a SQLite backup, build and test the target
commit, stop that instance, take a final backup, start the new build, then run a
read-only chat and scheduler smoke test. Finish one instance before updating the
next so a bad release does not take both bots down simultaneously.

Store device-specific commands and addresses in a private operator runbook.
