# Reference server, validator and heartbeat runner

The spec itself is [SPEC.md](../SPEC.md). Paths below are relative to the repo root.

## Quickstart

Requires Node 18+. There are no dependencies to install.

```sh
node server.mjs                       # API at http://127.0.0.1:4317 (set AOS_UI_DIR=/path/to/ui to also serve a dashboard UI)
node conformance/validate.mjs         # validate ./state against schemas and the spec's MUSTs
node conformance/validate.mjs path/to/state   # validate another state directory
node conformance/validate.mjs --selftest      # prove the validator catches the negative fixtures
```

The validator exits 0 when the state conforms and 1 when it does not. Each violation is printed as `FAIL: <file>: <message>`. Warnings, such as a stale heartbeat, do not affect the exit code.

## Directory map

```
SPEC.md                 AOS-1 normative specification
README.md               overview
ROADMAP.md              what exists, known limitations, ideas
server.mjs              reference HTTP server (state API; serves $AOS_UI_DIR if set)
heartbeat/              heartbeat runner and config.json
state/                  runtime state (the file-based binding)
  goal.json               Goal
  tasks.json              Task[]
  agents.json             Agent[]
  heartbeat.json          Heartbeat
  events.ndjson           append-only Events, one JSON object per line
schemas/                JSON Schema (draft 2020-12): goal, task, agent, heartbeat, event
conformance/
  validate.mjs            validator with a built-in schema-subset checker
  fixtures/valid/         state directories that must pass
  fixtures/invalid/       state directories that must each fail, one violation per directory
```

## What the validator checks

Schema checks use `type`, `required`, `enum`, `properties`, `items`, `pattern`, `minimum` and `minItems`. The semantic checks are:

- Goal, task, agent and goal-terminal statuses are valid lifecycle values.
- The Goal has a budget (SPEC section 7).
- Every Task has a non-empty `output_contract` and at least one `acceptance` check (section 6).
- Task ids are unique, every `depends_on` reference exists, and there are no dependency cycles.
- `assignee`, `current_task` and `goal_id` references resolve, and `attempts` does not exceed `max_attempts`.
- `events.ndjson` has parseable lines, valid Event shapes, and strictly increasing `seq`.
- Heartbeat liveness is consistent with the age of `ts` (alive under 1.5x, late under 3x, dead at 3x or more of `interval_s`). A terminal Goal must not have a `running` heartbeat.

The validator cannot see past writes, so append-only is checked structurally (monotonic `seq`, parseable lines). Appending only is up to the writer.

## Configuring dispatch

The heartbeat runner starts each `ready` Task by running a shell command. Set it in `heartbeat/config.json` under `dispatch_command`:

```json
{
  "interval_s": 60,
  "dispatch_command": "claude -p \"$AOS_TASK_PROMPT\""
}
```

Keep the exact key names and the variables available to the command in sync with `heartbeat/config.json` and the runner's header comment, which are the authority. The command is the only place a real agent runtime is plugged in. Anything that can be launched from a shell works: the Claude CLI, a script, or an HTTP client. Per SPEC section 7, a command that deploys, sends messages, spends money, or deletes things MUST be gated on human approval recorded as a `human.*` Event.

## Keeping it running

Run the server and the heartbeat as long-lived processes. The heartbeat file is the liveness signal, so a crashed runner shows up as `late` and then `dead` in the dashboard.

Quick, with nohup:

```sh
cd /path/to/agent-orchestration-standard
nohup node server.mjs > server.log 2>&1 &
```

Durable, with launchd on macOS. Save this as `~/Library/LaunchAgents/dev.aos.server.plist`, adjust the paths, then run `launchctl load ~/Library/LaunchAgents/dev.aos.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.aos.server</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/agent-orchestration-standard/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/agent-orchestration-standard</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/aos-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/aos-server.log</string>
</dict></plist>
```

Use the same pattern, with a different label and the heartbeat entry point, for the heartbeat runner if it is a separate process. Stop with `launchctl unload <plist>`. On Linux, an equivalent systemd unit with `Restart=always` works.
