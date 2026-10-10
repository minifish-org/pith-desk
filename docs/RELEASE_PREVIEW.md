Pith Desk is a lightweight local Mac client for the Pith agent SDK.

New in rc.16:

- Click draft attachments, sent images or generated-file images to enlarge
  them. The viewer offers Fit, Original size and zoom controls; Escape returns
  to the conversation or the underlying file preview.
- Fenced code blocks have a Copy button that copies their literal code.
  Cmd/Ctrl+F finds text in the current conversation, including folded tool
  results; Enter and Shift+Enter move between matches.
- Switching conversations remembers reading position and expanded tool results
  during the current app session. Back to latest returns to the newest output
  when you are reading earlier messages.
- Text drafts and text-file previews now allow 8 MiB. Long previews use pages
  of up to 256 KiB; large Markdown files appear as source text. Image attachments
  allow 50 MiB total per message, and generated-image previews allow 50 MiB per
  file. Provider limits may be lower.
- Larger text changes can show approval previews: up to 2 MiB and 20,000
  newlines per file, with up to 1 MiB of paged diff. Extensive changes use an
  accurate replacement diff when minimal-diff calculation reaches its budget.
- The embedded SDK accepts messages up to 128 MiB on its Codex WebSocket,
  MCP and agent-proxy paths. MCP tool calls allow ten minutes of inactivity;
  progress renews that window and user cancellation remains available.
- Context summaries retain larger tool-result excerpts, including trailing and
  intermediate error diagnostics. Codemode output budgets and timeout options
  now follow their documented contracts. Active Mistral/Pi streams no longer
  stop at a default one-minute total deadline.
- Completion-notification targets are retained for up to 90 days and 512
  records, subject to conversation removal or a newer result superseding them.

Previous changes (rc.15):

- Text drafts are saved separately for each conversation and restored when
  switching conversations or restarting the app. Successful sending or queueing
  clears only the submitted, unchanged text; rejected requests keep it. The
  native quit guard saves the latest text before closing the window. Image
  attachments retain their existing in-memory draft behavior.
- File-write and file-edit approvals show a colored diff using Pith's own edit
  matching and diff generation. If the file changes while awaiting approval,
  the preview refreshes and requires review again. Large or non-text changes
  keep their full tool arguments available for inspection.
- Generated files have a Preview button alongside Open, Reveal and Copy file,
  with the same button style. Markdown is rendered, UTF-8 text is displayed,
  and recorded PNG, JPEG, GIF and WebP files can be viewed within Desk.
  That release supported images up to 8 MiB and the first 256 KiB of long text.
  HTML and SVG remain source text; Open uses the associated application.

File preview does not add an image-generation service. The file list still
contains successful writes and edits recorded in the conversation; files made
only by shell commands are not discovered automatically. Drafts and previews
stay within the existing private-data and workspace checks. Normal application
builds continue to use Go and TypeScript with CGO disabled.

Previous changes (rc.14):

- The Dock shows `!` when any workspace needs approval, or the number of
  conversations with completed unread results. Ordinary running tasks add no
  Dock badge. Viewing a result clears its unread count; unread results survive
  app restarts. Approval takes priority over unread completion.
- Native menus provide New Conversation, Choose Workspace, Export Current
  Conversation and Settings, using the same actions and availability checks as
  the interface. Native shortcuts fire each action once.
- Drag existing workspace files into the composer to insert editable relative
  path references. Workspace boundaries are checked; files are not imported or
  changed. Image drag/drop and paste remain available.
- Copy replies as Markdown and copy generated files for pasting into Finder.
  Expand a command to see its original text, working directory and output;
  these details remain available when reopening its conversation.
- Closing the window or quitting asks before stopping active tasks across
  workspaces, including tasks waiting for approval. Keep working is the default
  choice; an idle application quits directly.
- macOS completion notifications can reopen their conversation after the app
  has quit, including a conversation in another workspace. Deleted or expired
  targets produce an explanation instead of selecting an unrelated conversation.
- MyGo is updated to 0.3.6. The pinned Pith SDK now accepts larger Codex
  WebSocket messages, fixing failures on responses above the previous 32 KiB
  read limit. Normal application builds keep CGO disabled.

Development improvements:

- Frontend hot reload and browser preview use isolated development data. Go
  changes still require restarting the backend.
- Go generates the shared TypeScript API contract; checks catch drift in types,
  host routes and request methods while preserving authenticated HTTP/WebSocket
  transport.

Previous changes (rc.13):

- OpenAI Codex subscription sign-in no longer shows or requires an API key.
  Settings refresh the provider's sign-in state immediately after login or
  logout, including when the sign-in dialog was already dismissed.
- OpenAI and OpenAI Codex use the Pith SDK's newer bundled model catalog,
  making GPT-6.1 Sol available with its image and thinking-effort capabilities.
  Native provider authentication and streaming remain in use. The catalog is
  bundled with the app; it is not fetched from OpenAI during startup.

Recent completion improvements (rc.12):

- Compact sidebar status icons replace the Running/Approval text badges.
  A blue ring with a fixed gap rotates during execution; it indicates activity
  without estimating task progress. Pending approval uses an amber icon.
- Successful completion leaves a blue unread dot until the conversation is
  viewed. Unread status survives restarting the app; old notifications are not
  replayed. Stopped and failed tasks do not produce completion notices.
- A task completing in another conversation shows an in-app notice while the
  app is in the foreground. Background completion sends a silent macOS
  notification. Both can open the completed conversation. The currently viewed
  conversation does not show a completion notice.
- System notifications require macOS permission and remain subject to Focus
  and screen-sharing rules. If notifications appear in Notification Center but
  no banner appears, check **System Settings → Notifications → when mirroring
  or sharing the display**, as well as your Focus settings.

Recent workspace concurrency improvements:

- Run tasks concurrently in different, non-overlapping workspace folders.
  Switch conversations, add a workspace or create a conversation while another
  task continues. The sidebar shows running tasks and pending approvals.
- Each task owns its input queue, approvals, cancellation, MCP connections,
  transcript, recovery journal and usage records. Stopping one task leaves
  other workspaces running.
- A workspace, including overlapping parent/child folders, still runs one task
  at a time. An occupied workspace offers **Open running conversation** so you
  can return to its task and queue a message.
- Model/effort and connection settings remain shared and require all tasks to
  stop before changing them. File tools keep their workspace boundary, and
  process environment inheritance is unchanged.

Recent generated-file improvements:

- Generated files are collapsed by default into one row with a file count.
  Expand the row to see paths and Open/Reveal actions. Refreshes keep the current
  expanded state; switching conversations collapses the section again.

Recent composer and typography improvements:

- The composer uses one button for sending and stopping. During a task, an empty
  composer shows a square Stop icon in the send button's original position.
  Adding text or images switches it back to send and queues the message.
- Conversation text and the composer use 14px type with a 1.5 line height.
  Paragraphs, lists, code blocks and messages have tighter spacing, and common
  controls and supporting labels are slightly larger.

Recent queue and timing improvements:

- Messages sent during a task enter the ordinary pending queue. Edit or delete
  an individual message, or click **Steer** to turn it into an **Instruction**
  for the next turn boundary. Edits preserve image attachments. Already received
  messages cannot be changed, and steering does not interrupt a running command.
- Pending mutations are committed through the Pith SDK before delivery and
  saved in the Durable journal for reviewed continuation after interruption.
- The existing status line shows the latest task's total elapsed time and
  average output tokens/s, including tools and waits. Input, cache and earlier
  tasks do not contribute to speed. Finished and stopped timing is saved; old
  runs remain unrecorded and crash checkpoints show no guessed speed.
- Settings dialogs use a slimmer scrollbar.

This preview connects more of Pith's existing SDK capabilities:

- Add independent compatible model connections in Settings. Official OpenAI and
  multiple compatible endpoints can coexist with separate models and credentials.
- Sign in through Pith's OAuth flow where the model provider supports it. HTTP
  MCP connections can also use OAuth discovery, PKCE and token refresh.
- View and edit workspace instructions, skills and prompt templates using Pith's
  discovery and expansion. Inherited instruction files remain read-only.
- Branch below a saved assistant reply, or select a saved node from the
  conversation menu. Branches preserve history without undoing file changes.
- Use **Compact** to summarize context while preserving recent messages and
  saved history. This sends a metered model request.
- MCP tool search and deferred schemas are enabled. Connections still discover
  their catalog; only needed tool descriptions are exposed to the model.
- Codemode is enabled for the agent to choose automatically. Nested tool calls
  keep the same workspace checks and approval policy as direct calls.
- Pith Durable saves admitted tasks and pending queued text/images. After an
  interruption, review and continue explicitly from saved history. Individual
  commands and remote effects are not automatically replayed.
- Estimated USD costs share the existing token statistics, with request details
  and saved rates. Prices come from the bundled SDK catalog or your custom
  rates; there is no pricing-service or exchange-rate dependency. Unknown and
  older unrecorded costs remain distinguishable from known zero prices.
- User messages align right, replies align left, and tool calls collapse into
  compact groups. Image attachments appear above content-sized text bubbles;
  mixed portrait and landscape previews keep their proportions.

Workspace folders still group their conversations, with folder-level creation
and conversation rename/export/delete actions. Removing a workspace unlinks it
and deletes its conversations, cost records and task journals, while leaving
workspace files and exported documents untouched.

Mac downloads are Apple Silicon only. The embedded Pith SDK preserves queued
inputs across retries and session rebuilds. Image selection, paste/drop,
previews, queued image inputs and persistent image history are included.
PNG, JPEG, GIF and WebP uploads
must total 50 MiB or less per message; provider limits may be lower. Images
require an image-capable model and are sent to the configured provider.

Download the macOS ARM64 preview ZIP, extract it and move **Pith Desk.app**
to Applications. It supports Apple Silicon Macs (M series); Intel Mac is not
supported. You do not need Go, Node.js or npm to run it. Apple Silicon native
launch is tested. The earlier `v0.1.0-rc.1` universal release is unchanged.

**This is an ad-hoc signed, unnotarized experimental preview. macOS may block it.**
If you trust this source and intend to test it, follow [Apple's Open Anyway instructions](https://support.apple.com/en-us/102445)
in System Settings → Privacy & Security. Do not disable Gatekeeper
globally. A Developer ID signed/notarized release is still pending.

Choose a disposable workspace first, configure your provider in Settings, then
use Test connection before sending a task. Connection tests make a small paid
model request; they do not access files or execute tools. API keys remain in
private local files; this app does not store them in Keychain.

Commands and MCP tools run with their own permissions. There is no OS sandbox.
Review permissions before enabling Full access. Completed actions cannot be
undone by Stop, and task continuation reviews history rather than replaying the
original request. Runtime status and diagnostics are not provider billing data.

Check the accompanying SHA-256 checksum and signing-status manifest. Read the
README and security documentation for current boundaries. Report reproducible
issues with the app version and, if useful, the metadata-only diagnostic export.
