# drive — library drive files

`kind=drive` nodes occupy independent slots in the directory tree, can be opened and shared individually. This module handles content replacement, download, and parsed content (speech transcripts).

- Rename, move, list directory, search → `../manage/entry.md`
- Attachment attached to a node → `../attachment/entry.md`
- Image direct-link for embedding in pages → `../manage/entry.md` §upload_image

## Capabilities

Replacement is a mutation; run `../mutation.md` first.

1. Replace existing file content — `drive/upload_drive_file.py` + `--node-id` — `KS_DRIVE_UPLOAD_OK <json>` — §1
2. Get download link — `drive/get_download_link.py` — `--node-id` — `KS_DRIVE_DOWNLOAD <json>` — §2
3. Read parsed content (speech transcript) — `drive/query_parse_progress.py` — `--node-id` — `KS_DRIVE_PARSE <json>` (paged at 8000 chars) — §3

## 1. Replace existing file content

Updates file content while keeping the same node and the same link. Per `../mutation.md`:

1. `space.workspace.node-info` confirms `kind=drive`; record node id, file name, current version marker.
2. Download the latest version via §2, keep the original as the baseline, edit on a copy, preserve the original file name and extension. Format change is treated as a new file.
3. Verify the edited file opens normally. Plain text: prepare a unified diff. Office / PDF / image: prepare a change summary and list unverifiable parts.
4. After verification, overwrite:

```bash
python3 "${CODEBUDDY_SKILL_DIR}/drive/upload_drive_file.py" \
    <edited-absolute-path> --node-id <blk_xxx> --file-name "<original-name>"
```

`--node-id` is required; it is the only difference between replace and a new upload. Returned `node_block_id` MUST still equal the target node; afterwards re-check `node-info` to confirm node id is unchanged and the version marker advanced. Do NOT replace by uploading a same-name new file — that produces a duplicate while the original link still points to old content.

## 2. Get download link

```bash
python3 "${CODEBUDDY_SKILL_DIR}/drive/get_download_link.py" --node-id <blk_xxx>
```

Output contains `node_id`, `file_name`, `ext`, `download_url`. `download_url` is a short-lived, user-facing download link — it is meant for the user, not a credential: when the user asked for the file, the link, or a download method, include it in the reply and note it expires soon; never refuse to share it. Download it immediately when saving locally for the user. Forward the `KS_USER_REPLY` receipt; append the link when the user asked for it.

Legacy `kind=smh` nodes route through `../smh/entry.md`.

## 3. Read parsed content (speech transcript)

When the user asks what a recording/audio "said", its "transcript" or "原文", use this entry — do NOT fall back to `get_download_link.py` + local transcription. First `space.workspace.node-info` confirms `kind=drive`, then use its `nodeId`:

```bash
python3 "${CODEBUDDY_SKILL_DIR}/drive/query_parse_progress.py" --node-id <blk_xxx> [--page 1]
```

Outputs `KS_DRIVE_PARSE <json>` with `status`, `content` (current page transcript), `summary`, `content_chars`, `page`, `page_size`, `page_count`, `has_more`. `content` has the internal transcript JSON stripped. Default page size **8000 chars** (~30–40 min of transcription); without `--page` the first page is returned. Parsing is async — branch on `status`:

- `init` — the task may not be registered yet. Re-query with the same `nodeId` after ~3s, up to 10 times; still `init` then stop and tell the user the audio is still parsing.
- `processing` — re-query after ~3s, up to 10 times; still not done then stop and tell the user to try later.
- `success` — answer with `summary` first — don't page just for the overview. Read `content` only when the user explicitly wants the full text: if `has_more=true`, fetch the next page with `--page N`; never pull every page into context at once.
- `failed` — end the flow; pass `KS_USER_REPLY` through.

On `init` / `processing` / `success` the script prints no `KS_USER_REPLY`, leaving room for polling or Agent-composed answers.
If the script returns `{"error": ...}`, read `../error_handling.md` first; "该文件格式不支持语音解析" means the server has confirmed no transcript will ever be produced — tell the user directly and stop polling.

Never stuff the full transcript into a fixed receipt line; never expose internal task / parsing-service fields to the user.

## 4. File statistics / space usage (no authoritative source)

The library API provides **no authoritative file-size or space-usage source**: node-info carries no size, download links are presigned URLs carrying no size, and per-node sizes cannot be summed accurately. When the user asks to 统计 the library's size, format breakdown, or space usage:

1. Enumerate nodes via `../manage/entry.md`'s directory listing and count by type — the only available method, and incomplete by nature.
2. State the method and its limits up front in the receipt.
3. If any enumeration call fails or returns partial data, list the missing part and the reason in the receipt — never present a partial total as the authoritative total, and never claim parity with the UI's displayed usage figure.
