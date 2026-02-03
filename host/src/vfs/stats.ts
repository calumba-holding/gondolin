import fs from "fs";

const { S_IFMT, S_IFREG, S_IFDIR, S_IFLNK } = fs.constants;

export type VfsStatOptions = {
  mode: number;
  nlink?: number;
  uid?: number;
  gid?: number;
  size: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

export class VfsStats {
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly atimeMs: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;

  constructor(options: VfsStatOptions) {
    this.mode = options.mode;
    this.nlink = options.nlink ?? 1;
    this.uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
    this.gid = options.gid ?? (typeof process.getgid === "function" ? process.getgid() : 0);
    this.size = options.size;
    this.atimeMs = options.atimeMs;
    this.mtimeMs = options.mtimeMs;
    this.ctimeMs = options.ctimeMs;
    this.birthtimeMs = options.birthtimeMs;
  }

  get atime() {
    return new Date(this.atimeMs);
  }

  get mtime() {
    return new Date(this.mtimeMs);
  }

  get ctime() {
    return new Date(this.ctimeMs);
  }

  get birthtime() {
    return new Date(this.birthtimeMs);
  }

  isFile() {
    return (this.mode & S_IFMT) === S_IFREG;
  }

  isDirectory() {
    return (this.mode & S_IFMT) === S_IFDIR;
  }

  isSymbolicLink() {
    return (this.mode & S_IFMT) === S_IFLNK;
  }

  isBlockDevice() {
    return false;
  }

  isCharacterDevice() {
    return false;
  }

  isFIFO() {
    return false;
  }

  isSocket() {
    return false;
  }
}

export type VfsDirentType = "file" | "dir" | "symlink";

export class VfsDirent {
  constructor(public readonly name: string, private readonly entryType: VfsDirentType) {}

  isFile() {
    return this.entryType === "file";
  }

  isDirectory() {
    return this.entryType === "dir";
  }

  isSymbolicLink() {
    return this.entryType === "symlink";
  }

  isBlockDevice() {
    return false;
  }

  isCharacterDevice() {
    return false;
  }

  isFIFO() {
    return false;
  }

  isSocket() {
    return false;
  }
}
