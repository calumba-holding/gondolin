import path from "path";
import fs from "fs";
import os from "os";

import { VfsDirent, VfsStats } from "./stats";
import { createErrnoError } from "./errors";

const { S_IFREG, S_IFDIR } = fs.constants;
const { errno: ERRNO } = os.constants;

export type InMemoryEntry = FileEntry | DirEntry;

type BaseEntry = {
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type FileEntry = BaseEntry & {
  kind: "file";
  content: Buffer;
};

type DirEntry = BaseEntry & {
  kind: "dir";
  children: Map<string, InMemoryEntry>;
};

export class InMemoryFileHandle {
  private position = 0;
  private closed = false;

  constructor(private readonly entry: FileEntry, public readonly path: string, public readonly flags: string) {
    if (flags === "a" || flags === "a+") {
      this.position = entry.content.length;
    }
    if (flags === "w" || flags === "w+") {
      entry.content = Buffer.alloc(0);
      entry.mtimeMs = Date.now();
    }
  }

  readSync(buffer: Buffer, offset: number, length: number, position?: number | null) {
    this.ensureOpen();
    const start = position ?? this.position;
    const available = Math.max(0, this.entry.content.length - start);
    const bytesRead = Math.min(length, available);
    if (bytesRead > 0) {
      this.entry.content.copy(buffer, offset, start, start + bytesRead);
    }
    if (position === null || position === undefined) {
      this.position = start + bytesRead;
    }
    this.entry.atimeMs = Date.now();
    return bytesRead;
  }

  async read(buffer: Buffer, offset: number, length: number, position?: number | null) {
    const bytesRead = this.readSync(buffer, offset, length, position);
    return { bytesRead, buffer } as const;
  }

  writeSync(buffer: Buffer, offset: number, length: number, position?: number | null) {
    this.ensureOpen();
    const start = position ?? this.position;
    const slice = buffer.subarray(offset, offset + length);
    const end = start + slice.length;
    if (end > this.entry.content.length) {
      const next = Buffer.alloc(end);
      this.entry.content.copy(next, 0, 0, this.entry.content.length);
      this.entry.content = next;
    }
    slice.copy(this.entry.content, start);
    if (position === null || position === undefined) {
      this.position = end;
    }
    this.entry.mtimeMs = Date.now();
    return slice.length;
  }

  async write(buffer: Buffer, offset: number, length: number, position?: number | null) {
    const bytesWritten = this.writeSync(buffer, offset, length, position);
    return { bytesWritten, buffer } as const;
  }

  readFileSync(options?: { encoding?: BufferEncoding } | BufferEncoding) {
    this.ensureOpen();
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? this.entry.content.toString(encoding) : Buffer.from(this.entry.content);
  }

  async readFile(options?: { encoding?: BufferEncoding } | BufferEncoding) {
    return this.readFileSync(options);
  }

  writeFileSync(data: Buffer | string, options?: { encoding?: BufferEncoding }) {
    this.ensureOpen();
    const buffer = typeof data === "string" ? Buffer.from(data, options?.encoding) : Buffer.from(data);
    if (this.flags === "a" || this.flags === "a+") {
      this.entry.content = Buffer.concat([this.entry.content, buffer]);
    } else {
      this.entry.content = Buffer.from(buffer);
    }
    this.position = this.entry.content.length;
    this.entry.mtimeMs = Date.now();
  }

  async writeFile(data: Buffer | string, options?: { encoding?: BufferEncoding }) {
    this.writeFileSync(data, options);
  }

  statSync() {
    this.ensureOpen();
    return createFileStats(this.entry);
  }

  async stat() {
    return this.statSync();
  }

  truncateSync(length = 0) {
    this.ensureOpen();
    if (length < this.entry.content.length) {
      this.entry.content = this.entry.content.subarray(0, length);
    } else if (length > this.entry.content.length) {
      const next = Buffer.alloc(length);
      this.entry.content.copy(next, 0, 0, this.entry.content.length);
      this.entry.content = next;
    }
    this.entry.mtimeMs = Date.now();
  }

  async truncate(length?: number) {
    this.truncateSync(length);
  }

  closeSync() {
    this.closed = true;
  }

  async close() {
    this.closeSync();
  }

  private ensureOpen() {
    if (this.closed) {
      throw createErrnoError(ERRNO.EBADF, "read", this.path);
    }
  }
}

export class InMemoryFsBackend {
  readonly readonly = false;

  private readonly root: DirEntry;
  private nextIno = 2;

  constructor() {
    const now = Date.now();
    this.root = {
      kind: "dir",
      ino: 1,
      mode: 0o755 | S_IFDIR,
      uid: 0,
      gid: 0,
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
      birthtimeMs: now,
      children: new Map(),
    };
  }

  openSync(entryPath: string, flags: string, mode?: number) {
    const normalized = normalizePath(entryPath);
    const entry = this.openEntry(normalized, flags, mode);
    return new InMemoryFileHandle(entry, normalized, flags);
  }

  async open(entryPath: string, flags: string, mode?: number) {
    return this.openSync(entryPath, flags, mode);
  }

  statSync(entryPath: string) {
    const entry = this.getEntry(normalizePath(entryPath));
    return entry.kind === "dir" ? createDirStats(entry) : createFileStats(entry);
  }

  async stat(entryPath: string) {
    return this.statSync(entryPath);
  }

  readdirSync(entryPath: string, options?: { withFileTypes?: boolean }) {
    const entry = this.getEntry(normalizePath(entryPath));
    if (entry.kind !== "dir") {
      throw createErrnoError(ERRNO.ENOTDIR, "readdir", entryPath);
    }
    const names = Array.from(entry.children.keys());
    if (!options?.withFileTypes) return names;
    return names.map((name) => {
      const child = entry.children.get(name)!;
      return new VfsDirent(name, child.kind === "dir" ? "dir" : "file");
    });
  }

  async readdir(entryPath: string, options?: { withFileTypes?: boolean }) {
    return this.readdirSync(entryPath, options);
  }

  mkdirSync(entryPath: string, options?: { recursive?: boolean; mode?: number }) {
    const normalized = normalizePath(entryPath);
    if (normalized === "/") return;
    const existing = this.entries().get(normalized);
    if (existing) {
      if (options?.recursive && existing.kind === "dir") return;
      throw createErrnoError(ERRNO.EEXIST, "mkdir", entryPath);
    }
    const parent = this.ensureParentDir(normalized, options?.recursive);
    const name = path.posix.basename(normalized);
    const now = Date.now();
    const entry: DirEntry = {
      kind: "dir",
      ino: this.nextIno++,
      mode: (options?.mode ?? 0o755) | S_IFDIR,
      uid: 0,
      gid: 0,
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
      birthtimeMs: now,
      children: new Map(),
    };
    parent.children.set(name, entry);
    return;
  }

  async mkdir(entryPath: string, options?: { recursive?: boolean; mode?: number }) {
    return this.mkdirSync(entryPath, options);
  }

  rmdirSync(entryPath: string) {
    const normalized = normalizePath(entryPath);
    if (normalized === "/") {
      throw createErrnoError(ERRNO.EINVAL, "rmdir", entryPath);
    }
    const { parent, name, entry } = this.getParent(normalized);
    if (entry.kind !== "dir") {
      throw createErrnoError(ERRNO.ENOTDIR, "rmdir", entryPath);
    }
    if (entry.children.size > 0) {
      throw createErrnoError(ERRNO.ENOTEMPTY, "rmdir", entryPath);
    }
    parent.children.delete(name);
  }

  async rmdir(entryPath: string) {
    return this.rmdirSync(entryPath);
  }

  unlinkSync(entryPath: string) {
    const normalized = normalizePath(entryPath);
    const { parent, name, entry } = this.getParent(normalized);
    if (entry.kind === "dir") {
      throw createErrnoError(ERRNO.EISDIR, "unlink", entryPath);
    }
    parent.children.delete(name);
  }

  async unlink(entryPath: string) {
    return this.unlinkSync(entryPath);
  }

  renameSync(oldPath: string, newPath: string) {
    const source = normalizePath(oldPath);
    const target = normalizePath(newPath);
    if (source === "/" || target === "/") {
      throw createErrnoError(ERRNO.EINVAL, "rename", oldPath);
    }
    const sourceParentInfo = this.getParent(source);
    const targetParent = this.ensureParentDir(target, false);
    const targetName = path.posix.basename(target);
    if (targetParent.children.has(targetName)) {
      throw createErrnoError(ERRNO.EEXIST, "rename", newPath);
    }
    sourceParentInfo.parent.children.delete(sourceParentInfo.name);
    targetParent.children.set(targetName, sourceParentInfo.entry);
  }

  async rename(oldPath: string, newPath: string) {
    return this.renameSync(oldPath, newPath);
  }

  truncateSync(entryPath: string, length: number) {
    const entry = this.getEntry(normalizePath(entryPath));
    if (entry.kind !== "file") {
      throw createErrnoError(ERRNO.EISDIR, "truncate", entryPath);
    }
    if (length < entry.content.length) {
      entry.content = entry.content.subarray(0, length);
    } else if (length > entry.content.length) {
      const next = Buffer.alloc(length);
      entry.content.copy(next, 0, 0, entry.content.length);
      entry.content = next;
    }
    entry.mtimeMs = Date.now();
  }

  async truncate(entryPath: string, length: number) {
    return this.truncateSync(entryPath, length);
  }

  private openEntry(entryPath: string, flags: string, mode?: number) {
    const normalized = normalizePath(entryPath);
    const entry = this.entries().get(normalized);
    const { create, truncate, append, readable, writable } = parseOpenFlags(flags);
    if (entry) {
      if (entry.kind !== "file") {
        throw createErrnoError(ERRNO.EISDIR, "open", entryPath);
      }
      if (truncate) {
        entry.content = Buffer.alloc(0);
        entry.mtimeMs = Date.now();
      }
      if (!readable && !writable) {
        throw createErrnoError(ERRNO.EINVAL, "open", entryPath);
      }
      return entry;
    }
    if (!create) {
      throw createErrnoError(ERRNO.ENOENT, "open", entryPath);
    }
    const parent = this.ensureParentDir(normalized, false);
    const name = path.posix.basename(normalized);
    const now = Date.now();
    const fileEntry: FileEntry = {
      kind: "file",
      ino: this.nextIno++,
      mode: (mode ?? 0o644) | S_IFREG,
      uid: 0,
      gid: 0,
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
      birthtimeMs: now,
      content: Buffer.alloc(0),
    };
    parent.children.set(name, fileEntry);
    if (append) {
      fileEntry.content = Buffer.alloc(0);
    }
    return fileEntry;
  }

  private entries(): Map<string, InMemoryEntry> {
    const map = new Map<string, InMemoryEntry>();
    const walk = (currentPath: string, entry: InMemoryEntry) => {
      map.set(currentPath, entry);
      if (entry.kind === "dir") {
        for (const [name, child] of entry.children) {
          const childPath = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
          walk(childPath, child);
        }
      }
    };
    walk("/", this.root);
    return map;
  }

  private getEntry(entryPath: string) {
    const entry = this.entries().get(entryPath);
    if (!entry) {
      throw createErrnoError(ERRNO.ENOENT, "stat", entryPath);
    }
    return entry;
  }

  private ensureParentDir(entryPath: string, recursive?: boolean) {
    const parentPath = path.posix.dirname(entryPath);
    const parentEntry = this.entries().get(parentPath);
    if (parentEntry && parentEntry.kind === "dir") return parentEntry;
    if (!recursive) {
      throw createErrnoError(ERRNO.ENOENT, "mkdir", parentPath);
    }
    if (parentPath === "/") return this.root;
    this.mkdirSync(parentPath, { recursive: true });
    return this.getEntry(parentPath) as DirEntry;
  }

  private getParent(entryPath: string) {
    const parentPath = path.posix.dirname(entryPath);
    const name = path.posix.basename(entryPath);
    const parent = this.entries().get(parentPath);
    if (!parent || parent.kind !== "dir") {
      throw createErrnoError(ERRNO.ENOENT, "stat", entryPath);
    }
    const entry = parent.children.get(name);
    if (!entry) {
      throw createErrnoError(ERRNO.ENOENT, "stat", entryPath);
    }
    return { parent, name, entry } as const;
  }
}

function normalizePath(entryPath: string) {
  const normalized = path.posix.normalize(entryPath);
  if (!normalized.startsWith("/")) {
    return "/" + normalized;
  }
  return normalized === "" ? "/" : normalized;
}

function parseOpenFlags(flags: string) {
  switch (flags) {
    case "r":
      return { create: false, truncate: false, append: false, readable: true, writable: false };
    case "r+":
      return { create: false, truncate: false, append: false, readable: true, writable: true };
    case "w":
      return { create: true, truncate: true, append: false, readable: false, writable: true };
    case "w+":
      return { create: true, truncate: true, append: false, readable: true, writable: true };
    case "a":
      return { create: true, truncate: false, append: true, readable: false, writable: true };
    case "a+":
      return { create: true, truncate: false, append: true, readable: true, writable: true };
    default:
      throw createErrnoError(ERRNO.EINVAL, "open");
  }
}

function createFileStats(entry: FileEntry) {
  return new VfsStats({
    mode: entry.mode,
    size: entry.content.length,
    atimeMs: entry.atimeMs,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
    birthtimeMs: entry.birthtimeMs,
  });
}

function createDirStats(entry: DirEntry) {
  return new VfsStats({
    mode: entry.mode,
    size: entry.children.size,
    atimeMs: entry.atimeMs,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
    birthtimeMs: entry.birthtimeMs,
  });
}
