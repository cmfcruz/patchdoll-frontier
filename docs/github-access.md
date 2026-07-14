# GitHub access for Codex

Patchdoll can let Codex push to GitHub **on demand** without ever exposing a token
to the model.

## How it works

1. The agent calls the `patchdoll_enable_github` MCP tool. The bridge validates
   its GitHub App credentials and installs a bridge-owned git credential helper.
2. Over the authenticated provider socket, the bridge asks the `agent`-owned
   worker to write the bot identity and helper path to the agent's global git
   config. The resulting files are owned by the real `agent` UID.
3. When the agent later runs `git push`, git invokes that helper, which makes a
   loopback request to the bridge's `GET /github/credential` endpoint.
4. The bridge mints (or reuses, for 30 minutes) a short-lived **GitHub App
   installation token** and hands it straight to git.

The MCP tool never returns the token and it is not stored in the transcript, a
Slack reply, or `.git/config`; the helper hands it directly to git on demand.
The agent only needs to call `patchdoll_enable_github` once per container
runtime; after that its git config invokes the helper when needed.

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

The commit identity is always derived from the GitHub App's bot account, so
commits attribute correctly (the same scheme GitHub Actions uses):

```text
name:  <app-slug>[bot]
email: <bot-user-id>+<app-slug>[bot]@users.noreply.github.com
```

The bridge resolves this during `patchdoll_enable_github` via `GET /app` (for the
slug) and `GET /users/<slug>[bot]` (for the id).

There are no environment variables or runtime settings for overriding the git
user name or email.

The App's installation permissions (e.g. Contents: read & write) determine what
Codex can do. If the `GITHUB_APP_*` variables are unset, `patchdoll_enable_github`
returns an error and Codex simply runs without GitHub access.

## Security note

GitHub App secrets remain only in the `patchdoll` bridge environment; the
provider worker never receives them. The bridge-owned helper is readable and
executable by the shared IPC group but not writable by `agent`.

The `GET /github/credential` endpoint is loopback-only by default. An agent with
GitHub enabled can intentionally cause git to obtain a short-lived installation
token, so GitHub App repository permissions remain the authorization boundary.
