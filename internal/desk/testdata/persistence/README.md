# Persistence compatibility fixtures

These literal fixtures are independent of Desk's current writers and use only
invented credentials, IDs and reserved example.invalid endpoints. Tests replace
`__WORKSPACE__` with a JSON-escaped private temporary workspace, never a user path.
Do not regenerate fixtures from current output to make a compatibility test pass.

The files cover settings (including the existing legacy shape), SDK auth,
MCP configuration and endpoint-bound OAuth state, catalog, Session v3, runtime
receipt, costs, image/text drafts in conversation/workspace scopes, deletion
intent, notification ledger v1 and durable JSONL format 1 with task/document
sidecars. Tests read them through actual Desk/SDK readers, check authority and
semantic write-back, and exercise missing/corrupt/version/tail distinctions.

`.desk.lock` is an OS lock, not a structured data format. Existing process-lock
tests verify exclusivity and release after exit; no arbitrary lock bytes become
an application-state fixture. Session legacy Pi versions are not supported.

Normal close/reopen and incomplete-tail fixtures do not establish process-crash
or power-loss guarantees. Atomic JSON replacement syncs file content before
rename but does not sync its parent directory or form a multi-file transaction.
