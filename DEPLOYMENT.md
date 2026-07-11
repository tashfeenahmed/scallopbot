# ScallopBot deployment guide

This is the public, provider-neutral deployment guide. Keep the real hostnames,
user identifiers, bot handles, credentials, OAuth files, database backups and
operator notes in a private runbook outside this repository.

## Requirements

- Node.js 24 or newer
- A process supervisor such as systemd or PM2
- A writable application data directory
- TLS termination when the dashboard is reachable outside localhost
- One private `.env` file per bot instance

Copy `.env.example` to `.env` on the target host and fill it there. Never copy a
production `.env` back into the repository.

## First deployment

```bash
git clone https://github.com/<owner>/<repository>.git /opt/scallopbot
cd /opt/scallopbot
npm ci
npm run check:secrets
npm run typecheck
npm test -- --run
npm run build
```

Start `node dist/cli.js start` with your supervisor. Configure its working
directory as `/opt/scallopbot` and load environment variables from the private
`.env` file without placing their values in the supervisor configuration.

## Safe update

1. Take a consistent SQLite backup while the current service is still healthy.
2. Fetch the exact commit to deploy.
3. Run `npm ci`, tests and the build before stopping the old process.
4. Stop the process, make one final database backup, and start the new build.
5. Verify the authenticated health endpoint, logs, dashboard pagination, one
   read-only chat, and an isolated scheduler smoke test with outbound delivery
   captured rather than sent.
6. Keep the backup until the new version has run through at least one retention,
   summary and scheduler cycle.

Use SQLite's backup command rather than copying an active WAL database as three
uncoordinated files:

```bash
sqlite3 /var/lib/scallopbot/memories.db ".backup '/var/backups/scallopbot/pre-deploy.db'"
```

The application performs additive migrations at startup. Do not deploy two
versions against the same database concurrently.

## Recover one conversation from a backup

Stop the service and take another verified backup first. The recovery command
requires the exact session ID twice, applies additive schema migrations without
running retention, restores only that transcript and its summaries, and leaves
the recovered session archived so it cannot become the active conversation:

```bash
npm run recover:session -- \
  --target /var/lib/scallopbot/memories.db \
  --backup /var/backups/scallopbot/known-good.db \
  --session <exact-session-id> \
  --confirm <exact-session-id>
```

The command prints counts and SHA-256 transcript checksums, never message
content. Matching source/target checksums are required before the transaction
commits, and repeating the same successful recovery is idempotent. It refuses
partial conflicts, active sessions, and explicit forget/prune tombstones; do
not use backup recovery to bypass a user's confirmed `/forget` request.

## Multiple bots on one host

Give every instance its own:

- system user and `HOME` directory;
- checkout or immutable release directory;
- `.env`, SQLite database and workspace;
- dashboard port and channel credentials;
- skills and OAuth credential directories;
- process-supervisor entry and logs.

Sharing an embedding service is fine. Sharing a writable database, workspace or
credential directory is not.

## Rollback

Stop the failed process, preserve its database for diagnosis, restore the last
verified backup to a new path, point the previous build at that restored path,
and start it. Never overwrite the only copy of a post-migration database.

## Security checklist

- Use SSH keys; disable password login.
- Bind the dashboard to localhost or protect it with authenticated TLS.
- Restrict `.env`, OAuth tokens, databases and backups to the service account.
- Keep full LLM trace retention disabled unless temporarily needed.
- Rotate a credential immediately if it enters git, even if a later commit
  removes it; deletion from the current tree does not erase git history.
- Run `npm run check:secrets` locally and in CI.

## Useful checks

```bash
npm run check:secrets
npm run typecheck
npm run lint
npm test -- --run
npm run build
curl --fail -H "X-API-Key: ${WEB_UI_API_KEY}" \
  http://127.0.0.1:<dashboard-port>/api/health
```
