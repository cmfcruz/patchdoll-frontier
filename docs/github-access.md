# GitHub access for Codex

Ember can let Codex push to GitHub **on demand** without ever exposing a token
to the model.

## How it works

1. Codex calls the `ember_enable_github` MCP tool (the bridge exposes it). This
   installs a git credential helper and a commit identity under
   `$HOME/.ember` / `$HOME/.gitconfig`.
2. When Codex later runs `git push`, git invokes that helper, which makes a
   loopback request to the bridge's `GET /github/credential` endpoint.
3. The bridge mints (or reuses, for 30 minutes) a short-lived **GitHub App
   installation token** and hands it straight to git.

The token is never returned to the model, so it can't leak into the transcript,
a Slack reply, or `.git/config`. Because `$HOME` is a persistent volume, the
helper survives restarts — Codex only needs to call `ember_enable_github` once.

## Configuration

Create a GitHub App, install it on the target repos/org, and set these as
balena environment variables or secrets (not in the image):

```text
GITHUB_APP_ID=...
GITHUB_APP_INSTALLATION_ID=...
GITHUB_APP_PRIVATE_KEY_BASE64=...   # base64 of the App's PEM private key
```

Generate the base64 private key with:

```sh
base64 -w0 your-app.private-key.pem
```

### Commit identity

By default the commit identity is derived from the GitHub App's bot account, so
commits attribute correctly (the same scheme GitHub Actions uses):

```text
name:  <app-slug>[bot]
email: <bot-user-id>+<app-slug>[bot]@users.noreply.github.com
```

The bridge resolves this during `ember_enable_github` via `GET /app` (for the
slug) and `GET /users/<slug>[bot]` (for the id). Set either variable to override:

```text
GIT_USER_NAME=...
GIT_USER_EMAIL=...
```

The App's installation permissions (e.g. Contents: read & write) determine what
Codex can do. If the `GITHUB_APP_*` variables are unset, `ember_enable_github`
returns an error and Codex simply runs without GitHub access.

## Security note

The `GET /github/credential` endpoint is bound to loopback only. On the trusted
single-user device this is sufficient; any local process already runs with the
same privileges. If you later harden this, add a per-helper shared secret that
the endpoint checks.
