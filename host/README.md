# @earendil-works/gondolin

This package provides the host-side library and CLI for the Gondolin sandbox VM.

## Installation

```bash
npm install @earendil-works/gondolin
# or
pnpm add @earendil-works/gondolin
```

## Quick Start

Run an interactive bash session in the sandbox:

```bash
npx @earendil-works/gondolin bash
```

On first run, the guest image (~200MB) will be automatically downloaded from
GitHub releases and cached in `~/.cache/gondolin/`.

## Library Usage

```ts
import { VM, createHttpHooks, MemoryProvider } from "@earendil-works/gondolin";

// Create a VM with network policy
const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com"],
  secrets: {
    GITHUB_TOKEN: {
      hosts: ["api.github.com"],
      value: process.env.GITHUB_TOKEN!,
    },
  },
});

// Use VM.create() to auto-download guest assets if needed
const vm = await VM.create({
  httpHooks,
  env,
  vfs: {
    mounts: { "/": new MemoryProvider() },
  },
});

// Run commands
const result = await vm.exec("curl -H 'Authorization: Bearer $GITHUB_TOKEN' https://api.github.com/user");
console.log(result.stdout);

await vm.close();
```

## Features

- **QEMU micro-VM** with virtio-serial control channel and virtio-net device
- **WebSocket API** for exec (stdin/pty + streaming stdout/stderr)
- **TypeScript network stack** implementing Ethernet, ARP, IPv4, ICMP, DHCP, TCP, UDP
- **HTTP/HTTPS interception** with request/response hooks and DNS-rebind-safe allowlists
- **TLS MITM** with auto-generated CA and per-host leaf certificates
- **VFS mounts** with hookable providers (memory, real filesystem, read-only)
- **Secret injection** that never exposes credentials inside the guest

## CLI Commands

### gondolin bash

Launch an interactive bash session:

```bash
gondolin bash [options]
```

Options:
- `--mount-hostfs HOST:GUEST[:ro]` - Mount host directory at guest path
- `--mount-memfs PATH` - Create memory-backed mount at path
- `--allow-host HOST` - Allow HTTP requests to host (supports wildcards)
- `--host-secret NAME@HOST[,HOST...][=VALUE]` - Add secret for specified hosts

Examples:

```bash
# Mount a project directory
gondolin bash --mount-hostfs ~/project:/workspace

# Mount read-only with network access
gondolin bash --mount-hostfs /data:/data:ro --allow-host api.github.com

# With secret injection (reads from $GITHUB_TOKEN env var)
gondolin bash --allow-host api.github.com --host-secret GITHUB_TOKEN@api.github.com
```

### gondolin exec

Run a command in the sandbox:

```bash
gondolin exec [options] -- COMMAND [ARGS...]
```

Examples:

```bash
# Simple command
gondolin exec -- ls -la /

# With mounted filesystem
gondolin exec --mount-hostfs ~/project:/workspace -- npm test
```

### gondolin ws-server

Start the WebSocket bridge server:

```bash
gondolin ws-server [options]
```

Options:
- `--host HOST` - Host to bind (default: 127.0.0.1)
- `--port PORT` - Port to bind (default: 8080)
- `--kernel PATH` - Custom kernel path
- `--initrd PATH` - Custom initrd path
- `--rootfs PATH` - Custom rootfs path
- `--memory SIZE` - Memory size (default: 1G)
- `--cpus N` - CPU count (default: 2)

## Network Policy

The network stack only allows HTTP and TLS traffic. TCP flows are classified and
non-HTTP traffic is dropped. Requests are intercepted and replayed via `fetch`
on the host side, enabling:

- Host allowlists with wildcard support
- Request/response hooks for logging and modification
- Secret injection without exposing credentials to the guest
- DNS rebinding protection

```ts
const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.example.com", "*.github.com"],
  secrets: {
    API_KEY: { hosts: ["api.example.com"], value: "secret" },
  },
  blockInternalRanges: true, // default: true
  onRequest: async (req) => { console.log(req.url); return req; },
  onResponse: async (req, res) => { console.log(res.status); return res; },
});
```

## VFS Providers

The VM exposes hookable VFS mounts:

```ts
import { VM, MemoryProvider, RealFSProvider, ReadonlyProvider } from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: {
      "/": new MemoryProvider(),
      "/data": new RealFSProvider("/host/data"),
      "/config": new ReadonlyProvider(new RealFSProvider("/host/config")),
    },
    hooks: {
      before: (ctx) => console.log("before", ctx.op, ctx.path),
      after: (ctx) => console.log("after", ctx.op, ctx.path),
    },
  },
});
```

## Asset Management

Guest images (kernel, initramfs, rootfs) are automatically downloaded from
GitHub releases on first use. The default cache location is `~/.cache/gondolin/`.

Override the cache location:
```bash
export GONDOLIN_GUEST_DIR=/path/to/assets
```

Check asset status programmatically:
```ts
import { hasGuestAssets, ensureGuestAssets, getAssetDirectory } from "@earendil-works/gondolin";

console.log("Assets available:", hasGuestAssets());
console.log("Asset directory:", getAssetDirectory());

// Download if needed
const assets = await ensureGuestAssets();
console.log("Kernel:", assets.kernelPath);
```

## Development

When working in the gondolin repository, assets are loaded from
`guest/image/out/` automatically if present.

```bash
# Build the guest image
cd guest && make image

# Run development CLI
pnpm run bash

# Run tests
pnpm run test
```

## Requirements

- Node.js >= 18
- QEMU (`qemu-system-aarch64` on ARM64, `qemu-system-x86_64` on x64)
- macOS or Linux

## License

MIT
