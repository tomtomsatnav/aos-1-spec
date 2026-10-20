# AOS-1: Agent Orchestration Standard

AOS-1 is a minimal, runtime-agnostic contract for orchestrating several AI agents toward one standing **Goal**. A periodic **Heartbeat** re-evaluates the Goal, reaps stalled work, plans, dispatches ready Tasks, and enforces budgets until the Goal is achieved, blocked, or cancelled. All state lives in plain files, and an append-only event log is the source of truth.

- [SPEC.md](SPEC.md): the normative specification; [ROADMAP.md](ROADMAP.md): status and known limits
- `schemas/`: JSON Schemas for Goal, Task, Agent, Event and Heartbeat
- `conformance/`: a zero-dependency validator with valid and invalid fixtures
- `heartbeat/`, `server.mjs`, `state/`: a reference heartbeat runner and HTTP server with a simulated dispatcher ([docs/reference-runner.md](docs/reference-runner.md))

Zero dependencies, Node 18+.

## Validate

```sh
make test                              # = node conformance/validate.mjs --selftest
node conformance/validate.mjs          # validate ./state (or pass another state dir)
node server.mjs                        # reference API on http://127.0.0.1:4317
AOS_UI_DIR=/path/to/ui node server.mjs   # also serve a dashboard UI from that directory
```

## Related repos

- Live dashboard (Claude Code monitor and AOS-1 viewer): https://github.com/tomtomsatnav/agent-orchestration-standard
- Orchestrator engine (experimental AOS-1 implementation driving Claude Code workers): https://github.com/tomtomsatnav/aos-orchestrator

[MIT License](LICENSE). Version: v1.0.0.
