/**
 * Build configuration schema for custom Linux kernel and rootfs builds.
 *
 * Users can generate a default config with `gondolin build --init-config`,
 * edit it, and then build with `gondolin build --config <file> --output <dir>`.
 */

export type Architecture = "aarch64" | "x86_64";

export type Distro = "alpine" | "nixos";

/**
 * Alpine Linux specific configuration.
 */
export interface AlpineConfig {
  /** Alpine version (e.g., "3.23.0") */
  version: string;
  /** Alpine branch (e.g., "v3.23"). Defaults to major.minor of version. */
  branch?: string;
  /** Mirror URL. Defaults to official CDN. */
  mirror?: string;
  /** Kernel package name. Defaults to "linux-virt". */
  kernelPackage?: string;
  /** Kernel image filename inside the package (e.g., "vmlinuz-virt"). */
  kernelImage?: string;
  /** Additional packages to install in the rootfs. */
  rootfsPackages?: string[];
  /** Additional packages to install in the initramfs. */
  initramfsPackages?: string[];
}

/**
 * NixOS specific configuration (for future use).
 */
export interface NixOSConfig {
  /** NixOS channel (e.g., "nixos-24.05") */
  channel: string;
  /** Path to a Nix expression that builds the system */
  systemExpression?: string;
  /** Additional system packages */
  packages?: string[];
}

/**
 * Container configuration for builds that require Linux tooling on macOS.
 */
export interface ContainerConfig {
  /** Whether to force container usage even on Linux. Default: false */
  force?: boolean;
  /** Container image to use. Default: "alpine:3.23" */
  image?: string;
  /** Container runtime. Default: auto-detect (docker, podman) */
  runtime?: "docker" | "podman";
}

/**
 * Rootfs image configuration.
 */
export interface RootfsConfig {
  /** Volume label. Default: "gondolin-root" */
  label?: string;
  /** Size in MB. If not specified, auto-calculated based on content. */
  sizeMb?: number;
}

/**
 * Custom init script configuration.
 */
export interface InitConfig {
  /** Path to custom rootfs init script. Uses default if not specified. */
  rootfsInit?: string;
  /** Path to custom initramfs init script. Uses default if not specified. */
  initramfsInit?: string;
}

/**
 * Build configuration for generating custom VM assets.
 */
export interface BuildConfig {
  /** Target architecture */
  arch: Architecture;

  /** Distribution to use */
  distro: Distro;

  /** Alpine-specific configuration (when distro is "alpine") */
  alpine?: AlpineConfig;

  /** NixOS-specific configuration (when distro is "nixos") */
  nixos?: NixOSConfig;

  /** Container configuration for cross-platform builds */
  container?: ContainerConfig;

  /** Rootfs image configuration */
  rootfs?: RootfsConfig;

  /** Custom init scripts */
  init?: InitConfig;

  /** Path to custom sandboxd binary. Uses built-in if not specified. */
  sandboxdPath?: string;

  /** Path to custom sandboxfs binary. Uses built-in if not specified. */
  sandboxfsPath?: string;
}

/**
 * Manifest describing the built assets.
 */
export interface AssetManifest {
  /** Manifest version for future compatibility */
  version: 1;

  /** Build configuration used */
  config: BuildConfig;

  /** Timestamp of the build */
  buildTime: string;

  /** Asset file information */
  assets: {
    /** Kernel image filename */
    kernel: string;
    /** Initramfs filename */
    initramfs: string;
    /** Root filesystem filename */
    rootfs: string;
  };

  /** Checksums for verification */
  checksums: {
    kernel: string;
    initramfs: string;
    rootfs: string;
  };
}

/**
 * Get the default build configuration for the current system.
 */
export function getDefaultBuildConfig(): BuildConfig {
  const arch = getDefaultArch();

  return {
    arch,
    distro: "alpine",
    alpine: {
      version: "3.23.0",
      kernelPackage: "linux-virt",
      kernelImage: "vmlinuz-virt",
      rootfsPackages: [
        "linux-virt",
        "rng-tools",
        "bash",
        "ca-certificates",
        "curl",
        "nodejs",
        "npm",
        "uv",
        "python3",
      ],
      initramfsPackages: [],
    },
    rootfs: {
      label: "gondolin-root",
    },
  };
}

/**
 * Get the default architecture based on the current system.
 */
export function getDefaultArch(): Architecture {
  const arch = process.arch;
  if (arch === "arm64") {
    return "aarch64";
  }
  return "x86_64";
}

/**
 * Validate a build configuration.
 */
export function validateBuildConfig(config: unknown): config is BuildConfig {
  if (typeof config !== "object" || config === null) {
    return false;
  }

  const cfg = config as Record<string, unknown>;

  // Required fields
  if (cfg.arch !== "aarch64" && cfg.arch !== "x86_64") {
    return false;
  }

  if (cfg.distro !== "alpine" && cfg.distro !== "nixos") {
    return false;
  }

  // Distro-specific validation
  if (cfg.distro === "alpine") {
    if (cfg.alpine !== undefined) {
      if (typeof cfg.alpine !== "object" || cfg.alpine === null) {
        return false;
      }
      const alpine = cfg.alpine as Record<string, unknown>;
      if (typeof alpine.version !== "string") {
        return false;
      }
    }
  }

  if (cfg.distro === "nixos") {
    if (cfg.nixos === undefined) {
      return false;
    }
    if (typeof cfg.nixos !== "object" || cfg.nixos === null) {
      return false;
    }
    const nixos = cfg.nixos as Record<string, unknown>;
    if (typeof nixos.channel !== "string") {
      return false;
    }
  }

  return true;
}

/**
 * Parse and validate a build configuration from JSON.
 */
export function parseBuildConfig(json: string): BuildConfig {
  const parsed = JSON.parse(json);
  if (!validateBuildConfig(parsed)) {
    throw new Error("Invalid build configuration");
  }
  return parsed;
}

/**
 * Serialize a build configuration to JSON.
 */
export function serializeBuildConfig(config: BuildConfig): string {
  return JSON.stringify(config, null, 2);
}
