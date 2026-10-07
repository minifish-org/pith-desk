# Workspace concurrency

Included in the rc.11 preview and current source builds. Earlier previews keep
the application-wide single-task restriction.

## Execution contract

Disjoint workspace folders can execute concurrently. The selected conversation
is only the displayed view: switching views, adding a workspace or creating a
conversation does not stop another task. Each conversation owns its session,
transcript projection, input queue, approval, cancellation, journal and metrics.
The sidebar shows running conversations and pending approvals.

One task can occupy a workspace at a time, including manual compression and
reviewed continuation. Canonical paths also prevent concurrent execution in
parent/child folders or aliases of the same directory. Occupancy starts before
durable admission is published and ends after execution cleanup and journal
settlement. The UI disables sending in an occupied workspace and offers a link
to its running conversation; the backend independently enforces admission.

Send and Stop HTTP requests carry the conversation ID. A stale Send is rejected
instead of being redirected after navigation. Stop targets its submitted ID.
Approval IDs identify their owning conversation even after the view changes;
lasting permission grants are persisted for that conversation alone. Queued
input mutations also use explicit conversation and message IDs.

Application metadata uses one service lock; streaming and tool execution occur
outside it. Every asynchronous callback captures a conversation runtime. The
catalog has one writer, while transcripts, receipts, costs and journals remain
separate per conversation. Snapshots contain a detached selected view and small
summaries of all live tasks. Idle unselected transcript projections are released
and reloaded on demand.

Each task gets independent MCP transports. Canceling a blocked external tool
closes that task's connections; another workspace retains its own connections.
The explicit Connections preview has separate transport ownership. OAuth token
providers are shared per endpoint to serialize refresh, and model OAuth
resolution is serialized against the shared auth file before streaming begins.

Closing the app cancels all live harnesses before waiting for any one and keeps
the application data lock through their final writes. Interrupted tasks are
recovered independently when opened. They require reviewed continuation;
commands and external actions are never automatically replayed.

## Remaining Desk boundaries

| Boundary | Current behavior |
| --- | --- |
| Shared settings | Model, effort, credentials and MCP configuration are app-wide. Changes, login and connection tests require all tasks to stop. |
| Active history | Rename, export, deletion and branch mutation are blocked for the affected running conversation. Unrelated idle conversations remain manageable. |
| Workspace resources | Instruction/skill/template edits and workspace removal are blocked if an active task occupies an overlapping folder. |
| Model protocols | The picker admits OpenAI Completions/Responses/Codex Responses, Anthropic, Google Generative AI and Mistral adapters. Bedrock, Vertex and other SDK adapters are not exposed. Independent custom connections currently offer five protocols, excluding Codex Responses. |
| Model routing | Pith's virtual model routers are not configured by Desk. |
| File tools | Desk's guarded file tools stay inside the workspace even in full access; inherited resources have additional path checks. Commands and MCP operate under their own permissions. |
| Process environment | Commands and local MCP processes inherit a small environment allowlist; MCP supports explicit overrides. |
| Images | PNG/JPEG/GIF/WebP only, up to 20 MiB of decoded images per message. |
| Application instances | One process may own an application data directory. Multiple workspace tasks run inside that process. |

Pi's TypeScript extension packages are also excluded by the current Pith Go SDK
construction surface. That is a Pith integration boundary, not a Desk-only lock.
Desk does not add an agent turn cap or wall-clock task timeout.

Folder admission does not sandbox commands or isolate external accounts. Hard
links and external actions can still share resources across disjoint folders.

## Validation

`internal/desk/concurrency_test.go` exercises simultaneous streams and approvals,
permission isolation, background input mutation, explicit cancellation, separate
request ledgers, overlapping-folder rejection, safe metadata edits, cancellation
of one blocked MCP call while another completes, and multi-task shutdown with
independent pending-input recovery. Host tests reject untargeted and stale sends.

Run the full checks with `GOWORK=off` to validate the pinned Pith dependency:

```sh
npm run check
CGO_ENABLED=1 go test -race -p 1 ./internal/...
npm run build:mac
```

An isolated local browser fixture also verifies adding workspace B while A runs,
simultaneous approvals, switching between live tasks, the occupied-workspace
send guard and navigation link, and stopping A while B continues.
