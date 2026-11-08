---
name: wecom-wedrive-reference
description: Fetch the WeCom WeDrive files a user attached as references. Load this Skill whenever the host injects a `<wecom_wedrive_references>` block, or whenever the message carries `@wedrive#<file_id>:"<name>"` badges. These attachments have no local copy — only a file id. It owns the host-managed WeCom authorization wait and the per-file fetch accounting, and delegates retrieval to the current account’s WeCom skill (the disk reference in `wecom-unified`, or `wecomcli-disk`).
description_en: Fetch the WeCom WeDrive files a user attached as references. Load this Skill whenever the host injects a <wecom_wedrive_references> block, or whenever the message carries wedrive file-id badges. These attachments have no local copy — only a file id. It owns the host-managed WeCom authorization wait and the per-file fetch accounting, and delegates retrieval to the current account’s WeCom skill.
author: WorkBuddy
version: "0.1.0"
user-invocable: false
---

# WeCom WeDrive references

When the user picks files from WeCom WeDrive, WorkBuddy attaches them **by reference**: nothing is downloaded to the user's machine, and the message carries only a file id per entry. An attachment you cannot read yet is still required source material — treat these exactly like an attached file whose bytes happen to live behind the WeCom connector.

The host lists every reference in a `<wecom_wedrive_references>` block, one `<file id="..." name="..." size="..." />` per entry. That list is authoritative: do not re-derive it from the badges, and do not drop entries from it.

The ids are **not workspace paths**. `Read` / `Glob` / `Grep` on them will fail or, worse, match something unrelated.

## Step 1 — Authorization is host-managed

For a WeCom login, use the injected credentials. If authorization is unavailable, stop and report it; do not start QR authorization. The following QR flow applies to other login types.

WorkBuddy owns the WeCom authorization UI. Your first `wecom-cli` invocation is what tells the host that this turn needs the connector, and the host then shows the authorization QR dialog inside WorkBuddy.

Start with the status probe, before any business command:

```bash
wecom-cli auth show --status
```

- Output is exactly `authorized` → go to Step 2.
- Output is exactly `unauthorized` → the host is now showing the authorization dialog. **Do not end the turn. Do not wait for a user reply. Do not tell the user to come back when they are done.** Scanning the QR code takes the user tens of seconds, so wait for it with this command — same role as `wecomcli-shared`'s `auth init` (block until the connector is usable):

```bash
i=0
auth_state=unauthorized
while [ "$i" -lt 25 ]; do
  case "$(wecom-cli auth show --status 2>/dev/null)" in
    authorized*) auth_state=authorized; break ;;
  esac
  sleep 2
  i=$((i+1))
done
echo "$auth_state"
```

Run it exactly as written. The shell is zsh, where `status` is a read-only alias of `$?`, so assigning to it aborts the wait with `read-only variable: status`.

It prints `authorized` as soon as the user finishes, and `unauthorized` if this slice elapsed. It waits at most ~50s on purpose, which is one wait slice:

- Prints `authorized` → go to Step 2 immediately and fetch.
- Prints `unauthorized` → run the **same** command again, up to 3 slices in total (~2.5 minutes of waiting). Only after the third slice still prints `unauthorized` treat it as **declined** and go to Step 4.

Two rules make the wait actually wait, and both matter more than they look:

- **Run it in the foreground.** Never pass `run_in_background`, and never enlarge the loop so one command can outrun the shell tool's foreground timeout. A wait that gets backgrounded returns a `task_id` and `(no output yet)` instead of a status.
- **A backgrounded result is not a timeout.** If the result carries a `task_id`, nothing has been waited for and the user has almost certainly not declined anything — re-run the same wait slice in the foreground instead of going to Step 4.

**Never run `wecom-cli auth init`** (in any form, interactive or not). It prints its own link and QR code and can open an external browser, which duplicates and competes with the WorkBuddy dialog the user is already looking at. Authorization is the host's surface; your only auth command is the read-only `wecom-cli auth show --status`.

Do not paste an authorization link or QR text into your reply, and do not ask the user to authorize anywhere other than the WorkBuddy dialog.

## Step 2 — Fetch every listed file

For a WeCom login, load `wecom-unified` and its `references/wecomcli-disk.md`. For other logins, load `wecomcli-disk` and `wecomcli-shared`. Read their parameter documentation before running anything; this Skill deliberately does not restate their command arguments, so that it cannot drift out of sync with them.

Work through the `<file>` list in order, fetching each one by its `id`.

- Fetch every entry before you answer. Do not infer a file's content from its `name` or `size`.
- The fetch writes a copy into your own sandbox and reports where. That path **is** a real local path — read it with the normal file tools. Only the original `id` is not a path.
- Pick the tool that fits the file type once you have it locally. A `.docx` / `.xlsx` / `.pdf` needs the appropriate reader, not a raw text read.
- If one fetch fails, retry that entry once. If it fails again, keep going with the remaining entries and record it as missing.
- If a fetch reports unauthorized mid-way (for example the credential expired), return to Step 1 once, then resume where you stopped.

## Step 3 — Report

Use the fetched content to answer the user's actual question — these files are input, not the topic. Do not narrate the fetch as a separate machine report. Then, only if something is missing, add one short line naming the files you could not fetch and why.

Do not describe a file as reviewed while it is still unfetched.

## Step 4 — Declined or unavailable

When the user declines authorization, or the wait times out:

- Do not retry, and do not ask for authorization again in this turn.
- Answer with whatever the rest of the message supports, and say plainly that the WeDrive files were skipped because WeCom was not authorized.
- Refer to them by their readable `name`. Do not guess at their contents.

## Output constraints

The active account skill (`wecom-unified` or `wecomcli-shared`) defines the shared output rules, including the ban on exposing id fields; they apply here and outrank anything in this section. Refer to files by their readable `name` — never by `file_id`.
