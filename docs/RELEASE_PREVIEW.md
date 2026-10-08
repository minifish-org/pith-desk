Pith Desk is a lightweight local Mac client for the Pith agent SDK.

New in rc.12:

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
must total 20 MiB or less per message; provider limits may be lower. Images
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
