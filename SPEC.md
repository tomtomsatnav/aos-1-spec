# AOS-1: Agent Orchestration Standard

Status: Draft 1.0 · Keywords MUST / SHOULD / MAY follow RFC 2119.

## 1. Purpose
AOS-1 defines a minimal, runtime-agnostic contract for orchestrating multiple AI agents toward a single standing **Goal**, with a periodic **Heartbeat** that keeps work moving until the Goal is met, blocked, or cancelled.

## 2. Core Concepts
| Concept | Definition |
|---|---|
| **Goal** | A durable objective with success criteria, a budget, and a status. Exactly one active Goal per Orchestrator. |
| **Orchestrator** | The single coordinating role. Plans, delegates, verifies, and owns Goal status. Does not do leaf work. |
| **Agent** | A worker with a declared role, capabilities, and a scoped task. Agents MUST NOT spawn Agents unless the Orchestrator grants `can_delegate`. |
| **Task** | A unit of work assigned to one Agent with inputs, an output contract, and acceptance checks. |
| **Heartbeat** | A periodic tick that re-evaluates the Goal and advances state. |
| **Event** | An append-only record of anything that happened. The source of truth. |
| **Artifact** | A file or structured output produced by a Task. |

## 3. Lifecycles
**Goal:** `draft → active → (blocked ⇄ active) → achieved | failed | cancelled`
**Task:** `pending → ready → running → (needs_review) → done | failed | cancelled`; `failed` MAY return to `ready` while `attempts < max_attempts`.
**Agent:** `idle → running → idle | errored | stalled`

Terminal states (`achieved`, `failed`, `cancelled`) MUST stop the Heartbeat.

## 4. Heartbeat Protocol
Each tick MUST execute these steps in order:
1. **Beat**: write `state/heartbeat.json` (`seq`, `ts`, `interval_s`, `status`).
2. **Observe**: load Goal, Tasks, recent Events.
3. **Reap**: mark Tasks `stalled` if no event within `stall_after_s`; requeue or fail per retry policy.
4. **Verify**: evaluate Goal `success_criteria`. If all pass → set Goal `achieved`, stop.
5. **Plan**: if no Task is `ready` or `running`, the Orchestrator creates new Tasks toward unmet criteria.
6. **Dispatch**: start `ready` Tasks up to `max_parallel`.
7. **Budget check**: if spend or ticks exceed budget → Goal `blocked` with reason, emit `budget.exceeded`.
8. **Emit**: append a `heartbeat.tick` Event summarizing the above.

Rules:
- Ticks MUST be idempotent and non-overlapping (a tick that finds the previous one still running MUST skip and emit `heartbeat.skipped`).
- Interval MUST be configurable; default 60 s. Backoff on consecutive errors: `min(interval * 2^n, 15 min)`.
- A missing heartbeat for `3 × interval_s` MUST be surfaced as `liveness: dead` by any observer.
- A human MAY pause (`status: paused`), resume, or cancel at any time; pause takes effect at the next tick boundary.

## 5. Data Contract (file-based reference binding)
```
state/
  goal.json         # Goal
  tasks.json        # Task[]
  agents.json       # Agent[]
  heartbeat.json    # Heartbeat
  events.ndjson     # append-only Events, one JSON object per line
artifacts/          # Task outputs
```

### Goal
```json
{ "id": "goal-1", "title": "", "description": "", "status": "active",
  "success_criteria": [{ "id": "c1", "text": "", "met": false }],
  "budget": { "max_ticks": 1000, "max_usd": 20 },
  "created_at": "ISO-8601", "updated_at": "ISO-8601" }
```
### Task
```json
{ "id": "t-1", "goal_id": "goal-1", "title": "", "assignee": "agent-id",
  "status": "pending", "depends_on": [], "attempts": 0, "max_attempts": 3,
  "inputs": {}, "output_contract": "", "acceptance": [""], "artifacts": [],
  "created_at": "", "updated_at": "" }
```
### Agent
```json
{ "id": "agent-ui", "role": "", "capabilities": [], "can_delegate": false,
  "status": "idle", "current_task": null, "last_event_at": null }
```
### Heartbeat
```json
{ "seq": 0, "ts": "ISO-8601", "interval_s": 60, "status": "running|paused|stopped",
  "liveness": "alive|late|dead", "last_tick_ms": 0, "consecutive_errors": 0 }
```
### Event
```json
{ "ts": "ISO-8601", "seq": 0, "type": "heartbeat.tick", "actor": "orchestrator|agent-id|human",
  "goal_id": "", "task_id": null, "data": {} }
```
Event types: `goal.created|updated|achieved|blocked|cancelled`, `task.created|ready|started|completed|failed|stalled|retried`, `agent.spawned|errored`, `heartbeat.tick|skipped|late|dead`, `budget.exceeded`, `human.pause|resume|cancel|note`.

## 6. Delegation Rules
- Every Task MUST have an output contract and at least one acceptance check.
- An Agent reports completion with artifacts and a one-paragraph result; the Orchestrator verifies acceptance before marking `done`.
- Agents MUST write only within their assigned paths. Overlapping write scopes MUST NOT run in parallel.
- Failures MUST be reported with cause, never silently retried more than `max_attempts`.

## 7. Safety & Governance
- Irreversible or outward-facing actions (deploys, sending messages, spending, deleting) MUST require human approval, recorded as a `human.*` Event.
- Budgets (ticks, cost, wall-clock) are mandatory; a Goal without a budget is invalid.
- All state changes MUST be traceable to an Event.

## 8. Observability (UI requirements)
A conforming dashboard MUST show: Goal + criteria progress, live heartbeat (seq, age, liveness), task board by status, agent roster, and the event stream. It MUST provide pause / resume / cancel controls and MUST derive `liveness` from heartbeat age (`alive` < 1.5×, `late` < 3×, `dead` ≥ 3× interval).

## 9. Conformance
An implementation conforms to AOS-1 if it satisfies every MUST in §3, §4, §5, §6, §7 and, if it ships a UI, §8.
