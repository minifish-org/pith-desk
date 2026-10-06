# Pith SDK integration

These capabilities are included in the rc.8 preview. Desk supplies controls and local persistence; the
SDK continues to own model protocols, session history, resources, tools and
execution. No new Go or npm application dependency was added.

## Reused capabilities

| Feature | Pith capability | Desk responsibility |
| --- | --- | --- |
| Independent model endpoints | `ModelRuntime.RegisterProvider`, native `StreamSimple` adapters | Named connections, scoped keys and editable model metadata |
| Instructions, skills, templates | `LoadResources`, coding-agent prompt expansion | Inventory, Markdown editor and Use action |
| Conversation branches | `SessionManager.Entries`, `Branch`, context reconstruction | Inline branch action below saved assistant replies and a history browser in the conversation menu |
| Manual compression | `AgentSession.Compact`, `GenerateSummary` | Button, streaming status and metered provider selection |
| Pending input | `Steer`, `FollowUp`, native `UpdatePendingMessage` | Queue ordinary input by default; explicit Steer, edit/delete controls and Durable mutation records |
| Deferred MCP | `MCPRuntime`, `ToolRegistry`, `CreateToolSearchTool` | Enabled connections and shared tool approvals |
| Code mode | `NewCodemodeTool`, SDK session store, nested execution hooks | Enable the tool and enforce the existing policy for each nested call |
| Provider OAuth | SDK `OAuth.Login`, `CreateAuthStorage`, `GetAuth` | Dialog, browser link, prompts and private auth path |
| MCP OAuth | SDK discovery, registration, PKCE, exchange and refresh | Private file store and temporary loopback callback |
| Durable task recovery | `durable.Harness`, JSONL storage and task definitions | Persist admission/queue/settlement and require reviewed continuation |
| Request cost estimates | Model catalog rates, `ai.CalculateCost` | Append immutable request records and show totals/details |
| Task timing and output speed | Reported SDK request usage | Monotonic task clock, average output rate and saved run receipts |

Virtual model routing is intentionally not enabled. MCP schemas are deferred,
but a connection still performs normal SDK discovery. Code mode is available to
the agent automatically; it is not compulsory for every tool call.

Single-message pending edits are a native Go SDK extension, rather than a Pi
terminal port. Ephemeral queue IDs identify input through native events and
agent rebuilds; they are omitted from provider JSON and saved transcripts.
The SDK checks that input is still pending and commits the host's journal
change before delivery can drain it. A failed journal write leaves the input
unchanged; already received input is rejected without re-enqueueing it.

The durable task wraps an ordinary coding-agent session. It checkpoints task
admission and queue events, then settles completion/failure. It does not journal
or replay each file operation, command or remote call. Closing the app leaves
an unfinished task; Stop aborts it. Continue always requires a user action and
uses saved history, so review uncertain effects first.

## Where prices come from

Pith includes the immutable Pi AI v1 catalog. The manifest records generation
at `2026-10-01T18:57:11.882Z`, the catalog revision and file hashes. See
[Pith catalog versioning](https://github.com/minifish-org/pith/blob/main/docs/sdk/catalog-versions.md)
and [the manifest](https://github.com/minifish-org/pith/blob/main/packages/ai/catalog/v1data/catalog-manifest.json).
The frozen Pi generator fetches models.dev and OpenRouter metadata and applies
provider-specific data and manual corrections. See the retained
[generator source](https://github.com/minifish-org/pith/blob/main/internal/conformance/ai_foundation_types/testdata/upstream/packages/ai/scripts/generate-models.ts.txt).

A provider's response supplies token usage; it does not generally supply the
catalog prices. Desk uses the SDK cost function with rates in **USD per million
tokens**, including cache/tier metadata. Each ledger record keeps the price
snapshot used for that request. Future catalog updates do not change past records.
No pricing-service request or currency conversion is made.

These are estimates, not a bill. Provider discounts, subscriptions, credit,
regional pricing and rate changes can make actual charges different. Catalog
models with no known price, endpoint overrides without custom prices, and
responses without usage are marked unknown and excluded from totals. An
explicit zero rate on a custom model is treated as a known free price. Use an
independent custom connection to enter endpoint-specific rates.

The ledger includes agent requests, retries and context summaries when usage is
reported, across all conversation branches. It does not reconstruct older
requests, include Settings connection probes or fetch provider account spending.
Reasoning tokens are shown when reported, but are already part of output tokens.

Estimates appear in the existing run statistics: the collapsed line shows the
recorded conversation estimate; expanded statistics show conversation and latest
task totals, with an inline request breakdown. There is no separate cost button
or dialog. Unrecorded, unknown and partly known costs are distinguished from a
known free price. The snapshot carries only totals; the ledger loads on demand.

The status line also shows elapsed time and average output tokens/s for the
latest task. Desk measures admission through execution cleanup with a monotonic
clock and persists the result in the run receipt. The numerator reuses SDK
request usage from the existing meter, including reasoning, retries and
summaries, even when prices are unknown. Input/cache/history tokens are excluded.
Tools and waits count toward elapsed time, so this is task throughput rather
than model decoding speed. Old receipts have no reconstructed timing; active
crash checkpoints retain only a lower-bound duration and do not show a rate.

## Local data and dependencies

All new state lives under the existing application data directory:

- `settings.json`: independent model connections and optional user rates.
- `auth.json`: SDK model OAuth credentials, mode 0600.
- `mcp-auth/`: endpoint-scoped MCP OAuth state, private JSON files.
- `costs/<conversation>.jsonl`: token usage and saved request prices.
- `durable/<conversation>/`: task and queued-message journal, including images.
- Existing session JSONL files retain messages, branches and compression entries.

No new Go or npm dependency was added; only the Pith version pin advanced.
Code mode uses the QuickJS/WASM and
wazero runtime already present in Pith. Durable uses the existing JSONL backend;
no SQLite dependency is added to the executable. OAuth host storage and callback
use Go's standard library. There is no exchange-rate service or new UI framework.
Production builds keep `CGO_ENABLED=0`.

## Versioned SDK dependency

Desk pins published Pith revision `92adcb39fd33` in `go.mod`. It includes SDK
fixes verified by the integration tests:

1. Composed custom providers retain their supplied model metadata.
2. The coding-agent session refreshes active tool schemas after tool search.
3. Codemode reuses immutable compiled QuickJS code across sandbox lifetimes,
   while keeping runtimes, tool bindings, memory limits and VM state separate.
4. Pending input can be edited, deleted or promoted atomically by native queue
   ID, with host persistence committed before delivery. A late promotion at the
   final queue poll is delivered before ordinary follow-up messages.

The fixes and their regression tests live in Pith, rather than a Desk fork.
No sibling checkout is required. Validate the pinned dependency with:

```sh
GOWORK=off npm run check
GOWORK=off npm run release:preview
```

The check and release workflows explicitly disable workspace overrides. Local
`go.work` files remain ignored for SDK development, but must not supply a release
dependency.
