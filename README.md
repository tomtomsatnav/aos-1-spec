# AOS-1: Agent Orchestration Standard

[![CI](https://github.com/tomtomsatnav/aos-1-spec/actions/workflows/ci.yml/badge.svg)](https://github.com/tomtomsatnav/aos-1-spec/actions/workflows/ci.yml)

AOS-1 is a minimal, runtime-agnostic contract for orchestrating several AI agents toward one standing **Goal**. A periodic **Heartbeat** re-evaluates the Goal, reaps stalled work, plans, dispatches ready Tasks, and enforces budgets until the Goal is achieved, blocked, or cancelled. All state lives in plain files, and an append-only event log is the source of truth.

- [SPEC.md](SPEC.md): the normative specification; [ROADMAP.md](ROADMAP.md): status and known limits
- `schemas/`: JSON Schemas for Goal, Task, Agent, Event and Heartbeat
- `conformance/`: a zero-dependency validator with valid and invalid fixtures
- `heartbeat/`, `server.mjs`, `state/`: a reference heartbeat runner and HTTP server with a simulated dispatcher ([docs/reference-runner.md](docs/reference-runner.md))

Zero dependencies, Node 18+.

## Validate

New here? Read the "Goal / Task / Heartbeat" parts of [SPEC.md](SPEC.md) first; this repo is a spec plus a reference implementation, not an agent runner. It does not need Claude Code.

```sh
make test                              # < 1 s. Prints one "pass" line per fixture; ends "selftest: all fixtures behaved as expected"
node conformance/validate.mjs          # check the sample ./state (or pass your own state dir); "OK ... 0 violation(s)" means it conforms
node server.mjs                        # reference API on http://127.0.0.1:4317 (PORT=4400 node server.mjs for another port)
AOS_UI_DIR=/path/to/ui node server.mjs   # also serve a dashboard UI from that directory
```

The server has no UI of its own: `/` shows a stub page, and `curl http://127.0.0.1:4317/api/state` returns the goal, tasks and agents as JSON. Its "agents" are simulated (see [docs/reference-runner.md](docs/reference-runner.md)); nothing here calls a model. "Heartbeat" = the periodic tick that re-evaluates the Goal; "conformance" = the validator that checks state files against the schemas and the spec's MUSTs.

## Related repos

- Live dashboard (Claude Code monitor and AOS-1 viewer): https://github.com/tomtomsatnav/agent-orchestration-standard
- Orchestrator engine (experimental AOS-1 implementation driving Claude Code workers): https://github.com/tomtomsatnav/aos-orchestrator

[MIT License](LICENSE). Version: v1.0.0.
