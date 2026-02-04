# Gondolin Sandbox

This repo implements an Alpine Linux based sandbox, primarily for agent use.  It
focuses on a QEMU-based micro-VM with a tiny guest supervisor, a virtio-serial
RPC, and a JavaScript based host control plane that enforces filesystem and
network policy.

## Quick Start (NPM)

```bash
# Run an interactive bash session in the sandbox
npx @earendil-works/gondolin bash

# Or install globally
npm install -g @earendil-works/gondolin
gondolin bash
```

Guest images are automatically downloaded from GitHub releases on first run.

## Motivation

We want to have a strong sandbox with a good security boundary that allows
agents to run untrusted code.  That sandbox we want to be connected to a control
plane that can be influenced to make security decisions on both the file system
and network layer and we want this whole system to run locally.

Our goals:

- Enable an actual Linux sandbox that is familiar to LLMs who are RLed on them.
- Guard network and filesystem access with explicit policy that can be code controlled.
- Fast create/exec/teardown for LLM workflows.
- Behavior parity between macOS and production Linux.
- Strong isolation between tenants to prevent cross-account access.

## Choices

* **VM:** we looked at Firecracker and QEMU and went with the latter.  A key motivation
  here is that firecracker cannot run on Macs which makes it harder to achieve
  parity between Mac and Linux, and divergence of behavior is always scary.
* **Networking:** the approach we went for here is to implement an ethernet stack in
  JavaScript.  From the perspective of the guest it's just a normal network, but all
  HTTP requests are implicitly re-encrypted by the host.  While this means that the
  trust store needs to trust the certificate of the host, it also means that the guest
  is well protected against sending bad HTTP request to untrusted destinations.  DNS
  is passed through, but DNS results are actually not used by the host at all.  The
  host triggers another resolve from scratch and ensures that blocked IPs cannot be
  accessed through DNS rebinding.
* **Filesystem:** the guest uses the file system from the image, plus a bunch of tmpfs
  mounds for temporary changes.  For persistance node VFS mounts are added through a
  singular FUSE instance.  Bind mounts are used to re-bind that instance to different
  paths.  This allows you to implement different virtual file system behavior in
  JavaScript.  While from a performance perspective very suboptimal, it has the benefit
  that you can lazy load resources from your own APIs or storage layers without writing
  complex native code.
* **Linux distribution:** currently this targets archlinux because of its quick boot
  times.  There might be better choices and this is something we should experiment with.
  In particular using nixOS is very appealing for agentic use.
* **Host bridge:** the host spawns a process that manages the QEMU lifecycle and
  plumbing for the sandbox to work (it's the endpoint for the virtio protocol).  The
  communication from that host process to the TypeScript library currently happens via
  WebSocket which allows you to create a network indirection between where the sandbox
  runs and where your code lives.  That choice is probably not optimal and we might want
  to revisit this.
* **Programming languages:** the sandbox is written in Zig because it produces small
  binaries and allows trivial cross compilation.  The host is written in TypeScript
  because it allows plugging in custom behavior trivially for the VM.

## Components

- [`guest/`](guest/) — Zig-based `sandboxd` daemon, Alpine initramfs build, and QEMU helpers.
- [`host/`](host/) — TypeScript host controller + WebSocket server that works with the guest.

## Library Usage

The host controller lets you spin up a sandboxed VM with controlled filesystem
and network access. Here's a minimal example that shows some of the power:

```ts
import { VM, MemoryProvider, createHttpHooks } from "@earendil-works/gondolin";

// Set up network policy with secret injection
const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com"],
  secrets: {
    GITHUB_TOKEN: {
      hosts: ["api.github.com"],
      value: process.env.GITHUB_TOKEN!,
    },
  },
});

// Create VM with in-memory filesystem and network hooks
// Use VM.create() to auto-download guest assets if needed
const vm = await VM.create({
  httpHooks,
  env,
  vfs: {
    mounts: { "/": new MemoryProvider() },
  },
});

// Run commands — secrets are injected by the host, never visible to the guest
await vm.exec("curl -H 'Authorization: Bearer $GITHUB_TOKEN' https://api.github.com/user");
await vm.close();
```

The guest never sees real credentials because the host intercepts outgoing
requests and injects secrets only for matching hosts.  See
[`host/README.md`](host/README.md) for full details on HTTP hooks, VFS mounts,
and the network stack.

## Requirements

**Note:** Currently only ARM64 (Apple Silicon, Linux aarch64) is tested. x86_64
support exists in the code but is untested.

These are required to use Gondolin. The guest image (kernel, initramfs, rootfs)
is automatically downloaded from GitHub releases on first run.

**macOS (Homebrew):**

```bash
brew install qemu node
```

**Linux (Debian/Ubuntu):**

```bash
sudo apt install qemu-system-arm nodejs npm
```

These are only needed if you want to build the guest image from source:

**macOS (Homebrew):**

```bash
brew install zig lz4 e2fsprogs
```

**Linux (Debian/Ubuntu):**

```bash
sudo apt install zig lz4 cpio curl e2fsprogs
```
