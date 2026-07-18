# Slack bot setup

Short checklist for creating a Eucleia Slack bot and connecting it to the
container.

## 1. Create the Slack app

1. Go to <https://api.slack.com/apps>.
2. Create a new app from scratch.
3. Pick the workspace that should run Eucleia.
4. In **Basic Information**, set the display name/icon however you want.

## 2. Enable Socket Mode

Eucleia uses Slack Socket Mode, so it does not need a public webhook URL.

1. Open **Socket Mode**.
2. Enable Socket Mode.
3. Create an app-level token with this scope:
   - `connections:write`
4. Save the app-level token as:
   - `SLACK_APP_TOKEN`

It should look like `xapp-...`.

## 3. Add bot permissions

Open **OAuth & Permissions** and add these bot token scopes:

- `app_mentions:read` — receive `@eucleia` mentions
- `chat:write` — post replies
- `channels:history` — read public channel thread context
- `groups:history` — read private channel thread context
- `im:history` — receive/read direct messages
- `mpim:history` — read multi-person DM thread context

Then install or reinstall the app to the workspace.

Save the bot token as:

- `SLACK_BOT_TOKEN`

It should look like `xoxb-...`.

## 4. Subscribe to events

Open **Event Subscriptions**.

1. Enable events.
2. Because Socket Mode is enabled, no public request URL is needed.
3. Subscribe to these bot events:
   - `app_mention`
   - `message.im`
4. Save changes and reinstall the app if Slack asks.

## 5. Pick an image variant

Each Eucleia image ships exactly one agent — there is no default and no combined
image. Choose the provider by selecting the matching tag:

```text
ghcr.io/stabledaemons/eucleia:latest-codex    # runs Codex CLI
ghcr.io/stabledaemons/eucleia:latest-claude   # runs Claude Code
```

The variant bakes `PROVIDER` into the image; you do not set it yourself.
Pull releases (`1.2.3-codex`, `1.2-claude`, …) or PR images (`pr-123-claude`)
the same way.

## 6. Configure the container

Set these as balena environment variables or secrets, not in the image:

```text
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

## 7. Authenticate the agent

The entrypoint authenticates whichever provider the variant ships, before the
bridge starts.

### Codex variant

Eucleia runs `codex login` during container startup.

For browser/device-code auth, do not set `OPENAI_API_KEY`. Watch the
container logs, open the printed URL, and enter the device code. The login
state persists under:

```text
/home/agent
```

Persist `/home/agent` as a volume so later restarts reuse the login and provider
memory. The startup supervisor migrates that volume to the real `agent` UID.

For noninteractive API-key auth instead, set this as a balena secret/env var:

```text
OPENAI_API_KEY=...
```

### Claude variant

Claude Code reads its credential from the environment at run time — there is no
login step. Set one of these as a balena secret/env var:

```text
CLAUDE_CODE_OAUTH_TOKEN=...   # from `claude setup-token`
ANTHROPIC_API_KEY=...         # Anthropic API key
```

## 8. Invite the bot

For channel mentions, invite the bot into each channel where it should respond:

```text
/invite @eucleia-daemon
```

Direct messages should work once `message.im` is subscribed and the app is
installed.

## 9. Allow users to invoke Eucleia

Eucleia only answers Slack users on its allowlists, and refuses everyone when
the lists are empty. Set at least one of these env vars (comma-separated Slack
user IDs) or startup fails:

```text
EUCLEIA_ADMINS=U0123ABCD
EUCLEIA_TRUSTED_USERS=U0456EFGH,U0789IJKL
```

To find a user ID in Slack: open the person's profile, choose the three-dot
menu, then "Copy member ID".
