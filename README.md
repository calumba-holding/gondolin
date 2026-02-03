# Eregion Sandbox

This repo implements a proof-of-concept for the agent sandbox.  It focuses on a
QEMU-based micro-VM with a tiny guest supervisor, a virtio-serial RPC, and a
host control plane that enforces filesystem and network policy.

## Motivation

Elwing's current Pyodide/WASM sandbox is not a sufficient security boundary on
servers because Python can escape through the surrounding JavaScript realm if
objects from other realms are passed to it, which is tricky to prevent.  The RFC
calls for isolating untrusted code by running a full Unix guest with strong
host-level isolation, while preserving a fast and developer-friendly workflow.

Key motivations from the RFC:

- Strong isolation between tenants to prevent cross-account access.
- Guard network and filesystem access with explicit policy.
- Fast create/exec/teardown for LLM workflows.
- Development parity between macOS and production Linux.

## Design

- **Guest (Alpine):** a minimal init boots, mounts a tiny root, brings up a
  `sandboxd` supervisor, and later (post-POC) runs a FUSE filesystem for `/data`
  and other virtual mounts.
- **Host controller:** launches QEMU, owns lifecycle, and exposes a stable API
  for `exec`, filesystem RPC, and optional network proxying.
- **Transport:** a length-prefixed, CBOR-encoded protocol over **virtio-serial**
- **Networking:** host-controlled transparent proxy with allow/deny policies and
  HTTPS MITM.
- **Dev/prod parity:** identical guest image + RPC; only QEMU accel flags vary
  (HVF on macOS, KVM on Linux).

## Repository layout

- `guest/` — Zig-based `sandboxd` daemon, Alpine initramfs build, and QEMU helpers.
- `host/` — TypeScript host controller + WebSocket server.
- `plans/` — POC plan, protocol draft, and follow-up roadmap.
