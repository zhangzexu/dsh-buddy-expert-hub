# export — export a doc, database, or page as a file

Exports the current content of one library node into a file the user can keep. This is a read: do not run `mutation.md`. One node per run.

| node kind | `--kind` | file | `file_type` |
|---|---|---|---|
| `doc` | `doc` | Markdown | `md` |
| `database` | `database` | CSV | `csv` |
| `web` (skill text may say page) | `web` | HTML | `html` |

Images or attachments in the body are packed into a zip. `file_type` stays `md` / `csv` / `html`; `file_name` ends with `.zip`. Save and open by `file_name`.

Not this module:

- `drive` source file → `../drive/entry.md`
- `smh` source file → `../smh/entry.md`
- an attachment on a node → `../attachment/entry.md`
- CSV text so you can answer from the table → `../database/get_database_content.py`
- page source so you can read or edit it → `../page/download_page_artifacts.py`
- `folder` and `link` have no export file

## Command

`--node-id` is required (bare id, `/space/d/{id}`, or `/p/{id}`). `--kind` is optional when you already know it (`doc` / `database` / `web`); omit it and the script reads `node-info`. `--time-zone` is an optional IANA name (`Asia/Shanghai`); omit it and date columns use UTC+8. An illegal timezone is ignored, not rejected. `--out` is the local file or directory; pass it only when the user asked to save on disk, and only to a path they named or the current workspace they asked to save into.

```bash
python3 "${CODEBUDDY_SKILL_DIR}/export/export_node.py" \
    --node-id "<nodeId>" [--kind doc|database|web] [--time-zone Asia/Shanghai] [--out "<path>"]
```

The script submits, polls until `done` or `failed`, and downloads when `--out` is set. Do not call `export-node` or `query-export-progress` yourself.

## Output

Success is one `KS_NODE_EXPORT` JSON line, then `KS_USER_REPLY`. Relay the receipt verbatim.

- `file_name` — name to show and to save as
- `file_type` — `md` / `csv` / `html`, including when the file is a zip
- `local_path` — present only when `--out` was passed and the save succeeded
- `download_url` — short-lived link, about 15 minutes. It is a user-facing download link, not a credential

When `local_path` is present, the file is already on disk; do not also paste `download_url`. When it is absent and the user asked for the file or a link, append `download_url` on its own line after the receipt and say it expires in about 15 minutes.

`{"error":...}` → `../error_handling.md`. Same user and same node: one export at a time (`19901` 「文档正在导出，请稍后再试」 means that node is already running; do not submit it again). Agent exports for one user are serial: `19901` 「已有导出任务进行中，请稍后再试」 means this user already has an agent export running, including a different node. Wait until it finishes, then export the next node. Do not submit several nodes at once. Client and agent share one pool of 100 documents per user per day; each accepted export counts as one document when it is queued, and the pool resets at 00:00. `50001` rejects only this export: if the message says today's quota is used up, stop until tomorrow; if it says N documents remain, export at most N. Do not loop. A system failure of a queued export (`50000`, or failReason 「导出超时，请重试」 / 「导出失败，请重试」 / 「导出任务异常，请重试」) can be retried once for the same node and does not count again. A too-large node fails with `56040` after submit; do not retry it.
