import os from "os";

import { createErrnoError } from "./errors";
import type { VfsStats } from "./stats";

const { errno: ERRNO } = os.constants;

export type VfsHookContext = {
  op: string;
  path?: string;
  oldPath?: string;
  newPath?: string;
  flags?: string | number;
  mode?: number;
  fh?: number;
  offset?: number;
  length?: number;
  size?: number;
  data?: Buffer;
  result?: unknown;
};

export type VfsHooks = {
  before?: (context: VfsHookContext) => void | Promise<void>;
  after?: (context: VfsHookContext) => void | Promise<void>;
};

export interface VfsBackendHandle {
  read(buffer: Buffer, offset: number, length: number, position?: number | null): Promise<{
    bytesRead: number;
    buffer: Buffer;
  }>;
  readSync(buffer: Buffer, offset: number, length: number, position?: number | null): number;
  write(buffer: Buffer, offset: number, length: number, position?: number | null): Promise<{
    bytesWritten: number;
    buffer: Buffer;
  }>;
  writeSync(buffer: Buffer, offset: number, length: number, position?: number | null): number;
  readFile(options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<Buffer | string>;
  readFileSync(options?: { encoding?: BufferEncoding } | BufferEncoding): Buffer | string;
  writeFile(data: Buffer | string, options?: { encoding?: BufferEncoding }): Promise<void>;
  writeFileSync(data: Buffer | string, options?: { encoding?: BufferEncoding }): void;
  stat(options?: object): Promise<VfsStats>;
  statSync(options?: object): VfsStats;
  truncate(len?: number): Promise<void>;
  truncateSync(len?: number): void;
  close(): Promise<void>;
  closeSync(): void;
}

export interface VfsBackend {
  readonly: boolean;
  open(path: string, flags: string, mode?: number): Promise<VfsBackendHandle>;
  openSync(path: string, flags: string, mode?: number): VfsBackendHandle;
  stat(path: string, options?: object): Promise<VfsStats>;
  statSync(path: string, options?: object): VfsStats;
  readdir(path: string, options?: object): Promise<Array<string | object>>;
  readdirSync(path: string, options?: object): Array<string | object>;
  mkdir(path: string, options?: object): Promise<void | string>;
  mkdirSync(path: string, options?: object): void | string;
  rmdir(path: string): Promise<void>;
  rmdirSync(path: string): void;
  unlink(path: string): Promise<void>;
  unlinkSync(path: string): void;
  rename(oldPath: string, newPath: string): Promise<void>;
  renameSync(oldPath: string, newPath: string): void;
  truncate(path: string, length: number): Promise<void>;
  truncateSync(path: string, length: number): void;
  close?: () => Promise<void> | void;
}

class HookedHandle implements VfsBackendHandle {
  constructor(
    private readonly inner: VfsBackendHandle,
    private readonly hooks: VfsHooks,
    private readonly path: string
  ) {}

  async read(buffer: Buffer, offset: number, length: number, position?: number | null) {
    await this.runBefore({ op: "read", path: this.path, offset: position ?? undefined, length });
    const result = await this.inner.read(buffer, offset, length, position);
    await this.runAfter({ op: "read", path: this.path, offset: position ?? undefined, length, result });
    return result;
  }

  readSync(buffer: Buffer, offset: number, length: number, position?: number | null) {
    this.runBeforeSync({ op: "read", path: this.path, offset: position ?? undefined, length });
    const bytesRead = this.inner.readSync(buffer, offset, length, position);
    this.runAfterSync({ op: "read", path: this.path, offset: position ?? undefined, length, result: bytesRead });
    return bytesRead;
  }

  async write(buffer: Buffer, offset: number, length: number, position?: number | null) {
    await this.runBefore({ op: "write", path: this.path, offset: position ?? undefined, length });
    const result = await this.inner.write(buffer, offset, length, position);
    await this.runAfter({ op: "write", path: this.path, offset: position ?? undefined, length, result });
    return result;
  }

  writeSync(buffer: Buffer, offset: number, length: number, position?: number | null) {
    this.runBeforeSync({ op: "write", path: this.path, offset: position ?? undefined, length });
    const bytesWritten = this.inner.writeSync(buffer, offset, length, position);
    this.runAfterSync({ op: "write", path: this.path, offset: position ?? undefined, length, result: bytesWritten });
    return bytesWritten;
  }

  async readFile(options?: { encoding?: BufferEncoding } | BufferEncoding) {
    await this.runBefore({ op: "readFile", path: this.path });
    const result = await this.inner.readFile(options);
    await this.runAfter({ op: "readFile", path: this.path, result });
    return result;
  }

  readFileSync(options?: { encoding?: BufferEncoding } | BufferEncoding) {
    this.runBeforeSync({ op: "readFile", path: this.path });
    const result = this.inner.readFileSync(options);
    this.runAfterSync({ op: "readFile", path: this.path, result });
    return result;
  }

  async writeFile(data: Buffer | string, options?: { encoding?: BufferEncoding }) {
    await this.runBefore({ op: "writeFile", path: this.path, data: Buffer.isBuffer(data) ? data : Buffer.from(data) });
    await this.inner.writeFile(data, options);
    await this.runAfter({ op: "writeFile", path: this.path });
  }

  writeFileSync(data: Buffer | string, options?: { encoding?: BufferEncoding }) {
    this.runBeforeSync({ op: "writeFile", path: this.path, data: Buffer.isBuffer(data) ? data : Buffer.from(data) });
    this.inner.writeFileSync(data, options);
    this.runAfterSync({ op: "writeFile", path: this.path });
  }

  async stat(options?: object) {
    await this.runBefore({ op: "stat", path: this.path });
    const result = await this.inner.stat(options);
    await this.runAfter({ op: "stat", path: this.path, result });
    return result;
  }

  statSync(options?: object) {
    this.runBeforeSync({ op: "stat", path: this.path });
    const result = this.inner.statSync(options);
    this.runAfterSync({ op: "stat", path: this.path, result });
    return result;
  }

  async truncate(len?: number) {
    await this.runBefore({ op: "truncate", path: this.path, size: len });
    await this.inner.truncate(len);
    await this.runAfter({ op: "truncate", path: this.path, size: len });
  }

  truncateSync(len?: number) {
    this.runBeforeSync({ op: "truncate", path: this.path, size: len });
    this.inner.truncateSync(len);
    this.runAfterSync({ op: "truncate", path: this.path, size: len });
  }

  async close() {
    await this.runBefore({ op: "release", path: this.path });
    await this.inner.close();
    await this.runAfter({ op: "release", path: this.path });
  }

  closeSync() {
    this.runBeforeSync({ op: "release", path: this.path });
    this.inner.closeSync();
    this.runAfterSync({ op: "release", path: this.path });
  }

  private async runBefore(context: VfsHookContext) {
    if (this.hooks.before) {
      await this.hooks.before(context);
    }
  }

  private async runAfter(context: VfsHookContext) {
    if (this.hooks.after) {
      await this.hooks.after(context);
    }
  }

  private runBeforeSync(context: VfsHookContext) {
    if (this.hooks.before) {
      const result = this.hooks.before(context);
      if (result && typeof (result as Promise<void>).then === "function") {
        throw new Error("async hook used in sync operation");
      }
    }
  }

  private runAfterSync(context: VfsHookContext) {
    if (this.hooks.after) {
      const result = this.hooks.after(context);
      if (result && typeof (result as Promise<void>).then === "function") {
        throw new Error("async hook used in sync operation");
      }
    }
  }
}

export class SandboxVfsProvider {
  readonly supportsSymlinks = false;
  readonly supportsWatch = false;

  constructor(private readonly backend: VfsBackend, private readonly hooks: VfsHooks = {}) {}

  get readonly() {
    return this.backend.readonly;
  }

  async open(path: string, flags: string, mode?: number) {
    await this.runBefore({ op: "open", path, flags, mode });
    const handle = this.wrapHandle(path, await this.backend.open(path, flags, mode));
    await this.runAfter({ op: "open", path, flags, mode, result: handle });
    return handle;
  }

  openSync(path: string, flags: string, mode?: number) {
    this.runBeforeSync({ op: "open", path, flags, mode });
    const handle = this.wrapHandle(path, this.backend.openSync(path, flags, mode));
    this.runAfterSync({ op: "open", path, flags, mode, result: handle });
    return handle;
  }

  async stat(path: string, options?: object) {
    await this.runBefore({ op: "stat", path });
    const stats = await this.backend.stat(path, options);
    await this.runAfter({ op: "stat", path, result: stats });
    return stats;
  }

  statSync(path: string, options?: object) {
    this.runBeforeSync({ op: "stat", path });
    const stats = this.backend.statSync(path, options);
    this.runAfterSync({ op: "stat", path, result: stats });
    return stats;
  }

  async lstat(path: string, options?: object) {
    return this.stat(path, options);
  }

  lstatSync(path: string, options?: object) {
    return this.statSync(path, options);
  }

  async readdir(path: string, options?: object) {
    await this.runBefore({ op: "readdir", path });
    const entries = await this.backend.readdir(path, options);
    await this.runAfter({ op: "readdir", path, result: entries });
    return entries;
  }

  readdirSync(path: string, options?: object) {
    this.runBeforeSync({ op: "readdir", path });
    const entries = this.backend.readdirSync(path, options);
    this.runAfterSync({ op: "readdir", path, result: entries });
    return entries;
  }

  async mkdir(path: string, options?: object) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "mkdir", path);
    }
    await this.runBefore({ op: "mkdir", path, mode: (options as { mode?: number })?.mode });
    const result = await this.backend.mkdir(path, options);
    await this.runAfter({ op: "mkdir", path, result });
    return result;
  }

  mkdirSync(path: string, options?: object) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "mkdir", path);
    }
    this.runBeforeSync({ op: "mkdir", path, mode: (options as { mode?: number })?.mode });
    const result = this.backend.mkdirSync(path, options);
    this.runAfterSync({ op: "mkdir", path, result });
    return result;
  }

  async rmdir(path: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "rmdir", path);
    }
    await this.runBefore({ op: "rmdir", path });
    await this.backend.rmdir(path);
    await this.runAfter({ op: "rmdir", path });
  }

  rmdirSync(path: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "rmdir", path);
    }
    this.runBeforeSync({ op: "rmdir", path });
    this.backend.rmdirSync(path);
    this.runAfterSync({ op: "rmdir", path });
  }

  async unlink(path: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "unlink", path);
    }
    await this.runBefore({ op: "unlink", path });
    await this.backend.unlink(path);
    await this.runAfter({ op: "unlink", path });
  }

  unlinkSync(path: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "unlink", path);
    }
    this.runBeforeSync({ op: "unlink", path });
    this.backend.unlinkSync(path);
    this.runAfterSync({ op: "unlink", path });
  }

  async rename(oldPath: string, newPath: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "rename", oldPath);
    }
    await this.runBefore({ op: "rename", oldPath, newPath });
    await this.backend.rename(oldPath, newPath);
    await this.runAfter({ op: "rename", oldPath, newPath });
  }

  renameSync(oldPath: string, newPath: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "rename", oldPath);
    }
    this.runBeforeSync({ op: "rename", oldPath, newPath });
    this.backend.renameSync(oldPath, newPath);
    this.runAfterSync({ op: "rename", oldPath, newPath });
  }

  async readFile(path: string, options?: { encoding?: BufferEncoding } | BufferEncoding) {
    const handle = await this.open(path, "r");
    try {
      return await handle.readFile(options);
    } finally {
      await handle.close();
    }
  }

  readFileSync(path: string, options?: { encoding?: BufferEncoding } | BufferEncoding) {
    const handle = this.openSync(path, "r");
    try {
      return handle.readFileSync(options);
    } finally {
      handle.closeSync();
    }
  }

  async writeFile(path: string, data: Buffer | string, options?: { encoding?: BufferEncoding; mode?: number }) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "open", path);
    }
    const handle = await this.open(path, "w", options?.mode);
    try {
      await handle.writeFile(data, options);
    } finally {
      await handle.close();
    }
  }

  writeFileSync(path: string, data: Buffer | string, options?: { encoding?: BufferEncoding; mode?: number }) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "open", path);
    }
    const handle = this.openSync(path, "w", options?.mode);
    try {
      handle.writeFileSync(data, options);
    } finally {
      handle.closeSync();
    }
  }

  async appendFile(path: string, data: Buffer | string, options?: { encoding?: BufferEncoding; mode?: number }) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "open", path);
    }
    const handle = await this.open(path, "a", options?.mode);
    try {
      await handle.writeFile(data, options);
    } finally {
      await handle.close();
    }
  }

  appendFileSync(path: string, data: Buffer | string, options?: { encoding?: BufferEncoding; mode?: number }) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "open", path);
    }
    const handle = this.openSync(path, "a", options?.mode);
    try {
      handle.writeFileSync(data, options);
    } finally {
      handle.closeSync();
    }
  }

  async exists(path: string) {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  existsSync(path: string) {
    try {
      this.statSync(path);
      return true;
    } catch {
      return false;
    }
  }

  async realpath(path: string) {
    await this.stat(path);
    return path;
  }

  realpathSync(path: string) {
    this.statSync(path);
    return path;
  }

  async access(path: string) {
    await this.stat(path);
  }

  accessSync(path: string) {
    this.statSync(path);
  }

  async readlink(path: string) {
    throw createErrnoError(ERRNO.ENOENT, "readlink", path);
  }

  readlinkSync(path: string) {
    throw createErrnoError(ERRNO.ENOENT, "readlink", path);
  }

  async symlink(target: string, path: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "symlink", path);
    }
    throw createErrnoError(ERRNO.ENOENT, "symlink", path);
  }

  symlinkSync(target: string, path: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "symlink", path);
    }
    throw createErrnoError(ERRNO.ENOENT, "symlink", path);
  }

  async truncate(path: string, length: number) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "truncate", path);
    }
    await this.runBefore({ op: "truncate", path, size: length });
    await this.backend.truncate(path, length);
    await this.runAfter({ op: "truncate", path, size: length });
  }

  truncateSync(path: string, length: number) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "truncate", path);
    }
    this.runBeforeSync({ op: "truncate", path, size: length });
    this.backend.truncateSync(path, length);
    this.runAfterSync({ op: "truncate", path, size: length });
  }

  async close() {
    if (this.backend.close) {
      await this.backend.close();
    }
  }

  private wrapHandle(path: string, handle: VfsBackendHandle) {
    if (!this.hooks.before && !this.hooks.after) {
      return handle;
    }
    return new HookedHandle(handle, this.hooks, path);
  }

  private async runBefore(context: VfsHookContext) {
    if (this.hooks.before) {
      await this.hooks.before(context);
    }
  }

  private async runAfter(context: VfsHookContext) {
    if (this.hooks.after) {
      await this.hooks.after(context);
    }
  }

  private runBeforeSync(context: VfsHookContext) {
    if (this.hooks.before) {
      const result = this.hooks.before(context);
      if (result && typeof (result as Promise<void>).then === "function") {
        throw new Error("async hook used in sync operation");
      }
    }
  }

  private runAfterSync(context: VfsHookContext) {
    if (this.hooks.after) {
      const result = this.hooks.after(context);
      if (result && typeof (result as Promise<void>).then === "function") {
        throw new Error("async hook used in sync operation");
      }
    }
  }
}
