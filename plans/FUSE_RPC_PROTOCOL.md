# FUSE ↔ RPC Protocol (Draft)

This document defines the POC RPC contract between the guest FUSE filesystem
and the host-side VFS provider. It builds on the envelope and framing described
in `plans/POC_PROTOCOL.md`.

## Envelope (from POC_PROTOCOL)
All frames are a CBOR map with keys:

| Key | Type | Required | Notes |
| --- | --- | --- | --- |
| `v` | u32 | yes | Protocol version (`1`). |
| `t` | string | yes | Message type. |
| `id` | u32 | yes | Correlation id (request ↔ response). |
| `p` | map | yes | Payload. |

For filesystem operations, `t` is one of:
* `fs_request`
* `fs_response`

## Core conventions
* **Path encoding:** UTF‑8 string, absolute, normalized with forward slashes and
  no trailing slash (except `/`). Guest FUSE normalizes before RPC.
* **Name encoding:** `name` fields must be a single path component (no `/` or
  NUL). If violated, host responds with `EINVAL`.
* **Error reporting:** responses include `err` (POSIX errno integer). `0`
  indicates success. Optional `message` for diagnostics.
* **Payload sizing:** aim for frames <= 64 KiB total. To keep the envelope +
  payload under this, `read`/`write` data should be capped at **60 KiB** per
  request. Larger reads/writes are chunked by FUSE into multiple requests.
* **Opaque handles:** host returns `fh` (u64) for open/create. Guest stores in
  FUSE file handle and passes back for read/write/release.

## Request/response schema
All filesystem requests are carried in `t=fs_request` with `p` fields:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `op` | string | yes | Operation name (see below). |
| `req` | map | yes | Operation-specific request payload. |

All responses are `t=fs_response` with `p` fields:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `op` | string | yes | Mirrors request op. |
| `err` | i32 | yes | POSIX errno (0 = OK). |
| `res` | map | no | Operation-specific response payload. |
| `message` | string | no | Debug message for nonzero `err`. |

## Minimal ops for POC

### `lookup`
Resolve a child name under a parent inode.

Request `req`:
* `parent_ino` (u64)
* `name` (string)

Response `res`:
* `entry` (map) — see **Entry** below (present when `err=0`)
* `entry_ttl_ms` (u32, optional; default 250 when `err=ENOENT`) — negative TTL

### `getattr`
Fetch attributes for an inode.

Request `req`:
* `ino` (u64)

Response `res`:
* `attr` (map) — see **Attr** below
* `attr_ttl_ms` (u32, optional; default 1000)

### `readdir`
List directory entries. Each returned dirent carries an `offset` that the guest
passes back as the next `offset` if the kernel stops early due to buffer limits.

Request `req`:
* `ino` (u64)
* `offset` (u64) — opaque offset provided by previous response
* `max_entries` (u32) — hint from FUSE

Response `res`:
* `entries` (array<dirent>)
* `next_offset` (u64) — 0 if EOF (may match last entry offset)
* `entry_ttl_ms` (u32, optional; default 1000)

`dirent`:
* `ino` (u64)
* `name` (string)
* `type` (u32) — DT_* style (1=REG, 2=DIR, 10=LNK)
* `offset` (u64) — opaque offset for resuming after this entry

### `open`
Open an existing file.

Request `req`:
* `ino` (u64)
* `flags` (u32) — POSIX open flags

Response `res`:
* `fh` (u64)
* `open_flags` (u32) — host overrides (optional)

### `read`
Read data from an open file handle.

Request `req`:
* `fh` (u64)
* `offset` (u64)
* `size` (u32) — max 60 KiB

Response `res`:
* `data` (bytes)

### `write`
Write data to an open file handle.

Request `req`:
* `fh` (u64)
* `offset` (u64)
* `data` (bytes) — max 60 KiB

Response `res`:
* `size` (u32) — bytes written

### `create`
Create and open a new file.

Request `req`:
* `parent_ino` (u64)
* `name` (string)
* `mode` (u32)
* `flags` (u32)

Response `res`:
* `entry` (map)
* `fh` (u64)
* `open_flags` (u32) — host overrides (optional)

### `mkdir`
Create a directory.

Request `req`:
* `parent_ino` (u64)
* `name` (string)
* `mode` (u32)

Response `res`:
* `entry` (map)

### `unlink`
Remove a file.

Request `req`:
* `parent_ino` (u64)
* `name` (string)

Response `res`: empty

### `rename`
Rename/move a path.

Request `req`:
* `old_parent_ino` (u64)
* `old_name` (string)
* `new_parent_ino` (u64)
* `new_name` (string)
* `flags` (u32) — RENAME_* flags

Response `res`: empty

### `truncate`
Set file size.

Request `req`:
* `ino` (u64)
* `size` (u64)

Response `res`: empty

### `release`
Close a file handle.

Request `req`:
* `fh` (u64)

Response `res`: empty

## Common structures

### Entry
Used by `lookup`, `create`, `mkdir`.

* `ino` (u64)
* `attr` (map) — Attr
* `attr_ttl_ms` (u32, optional; default 1000)
* `entry_ttl_ms` (u32, optional; default 1000)

### Attr
Fields mirror `struct stat` where needed by FUSE.

* `ino` (u64)
* `mode` (u32) — file type + permissions
* `nlink` (u32)
* `uid` (u32)
* `gid` (u32)
* `size` (u64)
* `atime_ns` (u64)
* `mtime_ns` (u64)
* `ctime_ns` (u64)

## Caching + timeouts
* **Entry/attr caching:** host may provide `entry_ttl_ms` + `attr_ttl_ms`. Guest
  caches for the specified duration, or defaults to 1000 ms when fields are
  omitted. Cache expiry should trigger fresh `lookup`/`getattr`.
* **Negative lookup caching:** if `lookup` returns `err=ENOENT`, guest caches a
  negative entry for `entry_ttl_ms` from the lookup response `res` (or defaults
  to 250 ms when omitted).
* **Handle caching:** host keeps handles until `release`. No implicit timeout in
  POC; guest must always `release` on close. Future versions may introduce
  `handle_ttl_ms` + `keepalive`.

## Notes
* Root inode is always `1` and is implicitly known by guest at mount time.
* Host is responsible for mapping inode numbers to provider paths and keeping
  them stable for the duration of the TTL.
* For now, all requests are serialized (single in-flight) as per POC protocol;
  the `id` field still allows future concurrency.
