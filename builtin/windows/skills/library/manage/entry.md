# manage — Space & Node Management

manage handles the space/directory tree, permissions, node comments, moving (within or across spaces) and renaming nodes, and image-to-link conversion. Search the library → the `library_search` tool; attach files to a node → `../attachment/entry.md`.

## Route here for

1. List visible spaces → `space.workspace.list-user-spaces`
2. List spaces linked to the current channel → `space.workspace.list-channel-spaces`
3. Create a team space → `space.workspace.create-space`
4. Create a folder (organize into groups) → `manage/create_folder.py`
5. Browse a directory → `space.workspace.list-nodes`
6. Look up a node's info → `space.workspace.node-info`
7. Look up collaborators or permission roles → `space.permission.collaborators`
8. Read node comments → `manage/get_node_comments.py`
9. Move a node, within a space or across spaces → `space.workspace.move-node`
10. Rename a node → `space.workspace.rename-node`
11. Convert an image to a public link → `manage/upload_image.py`
12. Attach a file to an existing node → `../attachment/entry.md`
13. Fetch an attachment's download link → `../attachment/entry.md`. Exporting a doc, database, or page as a file is `../export/entry.md`
14. Create / import / upload / store with no explicit target → `filing/entry.md`
15. User asks to organize / tidy / archive a space → `filing/organize.md`

Call `space.*` APIs through `space_api.py` at the skill root. Run `space_api.py <api-name> --help` when a parameter is unclear.

## Commands

### `space.workspace.list-user-spaces`

Default page is 50, max 100. Pass `--limit 100`. While `data.hasMore` is true, call again with `--offset` = previous `data.offset` + `data.limit` and concatenate `data.spaces[]`. One page is never the full list.

```bash
python3 "${CODEBUDDY_SKILL_DIR}/space_api.py" space.workspace.list-user-spaces --limit 100
python3 "${CODEBUDDY_SKILL_DIR}/space_api.py" space.workspace.list-user-spaces --limit 100 --offset 100
```

Read `spaceId`, `title`, `category`, `role` from `data.spaces[]`. Bucket by `category` into "我的资料 / 团队空间"; stop on any other value. Show `title` by default; show `role` only when the user asks about permissions. No results → say no library location was found.

### `space.workspace.list-channel-spaces`

Use when the user asks, in a session or group chat, which spaces the current channel is linked to / which libraries this group has bound. No params.

```bash
python3 "${CODEBUDDY_SKILL_DIR}/space_api.py" space.workspace.list-channel-spaces
```

Read `data.spaces[].{spaceId,title,url}`. Show `title` together with the backend-returned `url`; no results → say the current session has no library space linked yet.

### `space.workspace.create-space`

`--title` optional (omitted → unnamed team space). Always lands in a team space; create it and show the final name.

```bash
python3 "${CODEBUDDY_SKILL_DIR}/space_api.py" space.workspace.create-space --title "我的团队空间"
```

Returns `data.space`; `category=team`, `role=owner`. Reuse the returned `spaceId`; show `title` (an empty string is "未命名空间") and `/space/s/{spaceId}`; show the raw ID only if asked.

### `manage/create_folder.py`

A folder is a pure container node with no body; move existing nodes into it with `move-node`, or point `--parent-id` at it in `doc/create_doc.py` / `import-local-file`.

`--title` required (plain text); `--space-id` omitted → default space; `--parent-id` omitted → space top level, given → subfolder there.

```bash
# create a folder at the top level of the default space
python3 "${CODEBUDDY_SKILL_DIR}/manage/create_folder.py" --title "项目资料"

# create a subfolder under a given parent node
python3 "${CODEBUDDY_SKILL_DIR}/manage/create_folder.py" \
    --title "会议纪要" --space-id "<spaceId>" --parent-id "<parentNodeId>"
```

On success, read `nodeBlockId`, `nodeKind`, `url` from `KS_FOLDER_CREATE`; pass `KS_USER_REPLY` through as-is, show `url`, never the internal node ID.

Organize-into-a-folder ask that finds same-name folders already present (empty ones included) → don't create another and don't stop to ask: reuse one (the first match) as the mount target, `move-node` the documents in, and confirm where they landed. Redundant duplicates may be offered as cleanup afterwards — a suggestion in the receipt, never a gate before filing.

### `space.workspace.list-nodes`

Content questions — search, find, summarize, analyze, evaluate, overview — go to the `library_search` tool instead; `list-nodes` is for structural listing and organize/file flows only.

`--space-id` names the target space; `--parent-node-id` names the parent. Listing a specific node's children needs both that node's `spaceId` and its `parentNodeId`; given only a `nodeId`, resolve `data.node.spaceId` via `node-info` first. Neither given → lists the root of 我的资料.

Default page is 50, max 100. Pass `--limit 100`. While `data.hasMore` is true, call again with `--offset` = previous `data.offset` + `data.limit` and concatenate `data.nodes[]`. One page is never the full directory.

```bash
# list the root of a given space
python3 "${CODEBUDDY_SKILL_DIR}/space_api.py" space.workspace.list-nodes --space-id "<spaceId>" --limit 100

# list a given node's children
python3 "${CODEBUDDY_SKILL_DIR}/space_api.py" space.workspace.list-nodes \
    --space-id "<spaceId>" --parent-node-id "<nodeId>" --limit 100
```

Preserve the order of `data.nodes[]`. Browsing shows `id`, `title`, `kind`, `url`, `nodes`; locating or writing keeps `spaceId`, `parentId` in hand. Same-name nodes → let the user disambiguate. `nodes` non-empty → it can be expanded further. A "list what's here" ask is answered with the actual titles — every child listed, one per line or in a table, paginating until all are covered; a type-count summary with a few examples is a non-answer for a browse ask, whatever the count (111 included).

### `space.workspace.node-info`

Pass `--node-id`, or a `--url` shaped like `/space/d/{nodeId}`; when both are given, `--node-id` wins. A `/space/s/{spaceId}` link is a space, not a node — use the `library_search` tool or `list-nodes --space-id` instead.

```bash
python3 "${CODEBUDDY_SKILL_DIR}/space_api.py" space.workspace.node-info --node-id "<nodeId>"
```

Read `data.node`:

- Routing and display: `id`, `title`, `kind`, `url`
- Writing, moving, and downstream modules: `spaceId`, `parentId`, `createdBy`, `version`

Failure → say the node was not found or is not accessible.

### `space.permission.collaborators`

A space ID or `/space/s/{spaceId}` link → pass `--space-id`; a node → pass `--node-id`.

```bash
# space-level collaborators
python3 "${CODEBUDDY_SKILL_DIR}/space_api.py" space.permission.collaborators \
    --space-id "<spaceId>"

# node-level collaborators
python3 "${CODEBUDDY_SKILL_DIR}/space_api.py" space.permission.collaborators \
    --node-id "<nodeId>"
```

Read `data.myRole`, `data.createdBy`, and `data.collaborators[].{name,uid,role}`. Show each member's nickname and role; fall back to the UID when the nickname is empty. No members → say this resource has no collaborators yet.

### `manage/get_node_comments.py`

Reads a node's unresolved comments by default; `--discussion-id` scopes to one thread, `--include-resolved` includes resolved comments.

```bash
python3 "${CODEBUDDY_SKILL_DIR}/manage/get_node_comments.py" \
    --node-id "<nodeId>"
```

Read the comment threads, anchors, and `comments[].plainText` from `threads[]` after `KS_DOC_COMMENTS`.

### `space.workspace.move-node`

- Read the source node via `node-info` before moving; also read the target directory's node when one is named.
- Confirm the current location from the source node's `parentId`.

`--node-id` is required; `--target-parent-id` omitted → root of the target space; `--after-node-id` omitted → appends to the end. Target directory in another space → add `--target-space-id`, and make sure `--target-parent-id` names a node in *that* space.

```bash
python3 "${CODEBUDDY_SKILL_DIR}/space_api.py" space.workspace.move-node \
    --node-id "<nodeId>" --target-parent-id "<parentNodeId>" [--target-space-id "<spaceId>"]
```

`data.status` is `success` → done, confirm the new location. `pending` → the move to the other space is still running (the whole subtree goes with it); poll `data.taskId` below before telling the user it landed.

Project spaces and nodes under a system file can't be moved to another space; one node allows only one move at a time. Never show the internal node ID.

### `space.workspace.move-node-progress`

Only for the `pending` case above.

```bash
python3 "${CODEBUDDY_SKILL_DIR}/space_api.py" space.workspace.move-node-progress \
    --task-id "<taskId>"
```

- `pending` / `running` — re-query after ~2s; still unfinished after ~5 minutes → stop polling, say the move is still in progress.
- `success` — the node is in the target space; `data.postCheckWarning` non-empty → say it landed but needs a manual check.
- `failed` — report `data.failReason`.

A `taskId` lives 24 hours; not-found means expired — re-check the location with `node-info` instead of retrying.

### `space.workspace.rename-node`

`--node-id` and a plain-text `--title` are required (the API has no `conflictStrategy` / `overwrite`).

```bash
python3 "${CODEBUDDY_SKILL_DIR}/space_api.py" space.workspace.rename-node \
    --node-id "<nodeId>" --title "新标题"
```

Any node can be renamed; for a drive file, pass its full file name — the server keeps the node title and the drive file name in sync. Confirm the new title in the reply.

### `manage/upload_image.py`

Converts a local image or a third-party image URL into an embeddable public link. It creates no library node. `<path>` and `--url` are mutually exclusive; `--file-name` and `--content-type` are optional.

When the user's ask carries "不用建条目 / 不想占地方 / 只要个链接", that is this script's exact contract (public link, no node) — route here, run it, done. It is never a reason to skip the library and hand-encode a base64 data-URI: a data-URI embeds a local copy, not a hosted link, and fails the user's real ask (a URL usable in any web page).

Local images cap at 10 MiB; supported formats: `.png / .jpg / .jpeg / .gif / .webp / .bmp / .svg / .heic / .heif / .tiff`.

```bash
# local image
python3 "${CODEBUDDY_SKILL_DIR}/manage/upload_image.py" ./cover.png

# convert a third-party image to a public link
python3 "${CODEBUDDY_SKILL_DIR}/manage/upload_image.py" \
    --url "https://example.com/foo.png"
```

On success, use `url` from `KS_IMAGE_UPLOAD_OK`; pass `KS_USER_REPLY` through as-is.
