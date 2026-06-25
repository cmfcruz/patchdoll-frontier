# Ember runtime boundary

Ember's HTTP bridge is a local control plane for the agent, not a public API.

The server exists so Slack can invoke the agent (Codex or Claude Code, depending
on the image variant) and so the agent can consume Ember-only features through
loopback endpoints, namely temporary GitHub credentials. It is intended to be
Ember's exclusive window to external systems from inside the runtime.

This build is configured by environment variables only. `GET /settings` reports
the resolved configuration read-only; there is no endpoint or tool to mutate it
at runtime, so the configuration surface is fixed at process start.

## Binding model

By default the bridge binds to `127.0.0.1`, and the agent reaches it through
loopback URLs such as:

```text
http://127.0.0.1:3000/mcp
http://127.0.0.1:3000/github/credential
```

Do not bind the bridge to a public or untrusted interface. If a deployment ever
needs to listen beyond loopback, add an explicit authentication and authorization
layer before exposing `/settings`, `/mcp`, `/agent`, or `/github/credential`.

## Threat model

The current design assumes a trusted, single-user runtime where local processes
already have the same practical authority as Ember and the agent. Under that model,
the bridge endpoints are privileged local integration points rather than remote
service boundaries.

Reviews and future changes should preserve that assumption clearly: local-only
access is intentional; public network exposure is out of scope unless the
security model changes first.
