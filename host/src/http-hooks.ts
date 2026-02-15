import crypto from "crypto";
import net from "net";

import type { HttpHookRequest, HttpHooks } from "./qemu-net";
import { HttpRequestBlockedError } from "./http-utils";
import { extractIPv4Mapped, parseIPv6Hextets } from "./ip-utils";

export type SecretDefinition = {
  /** host patterns this secret may be sent to */
  hosts: string[];
  /** secret value */
  value: string;
};

export type CreateHttpHooksOptions = {
  /** allowed host patterns (empty = allow all) */
  allowedHosts?: string[];
  /** secret definitions keyed by env var name */
  secrets?: Record<string, SecretDefinition>;
  /** placeholder replacement in URL query string (default: false) */
  replaceSecretsInQuery?: boolean;
  /** whether to block internal ip ranges (default: true) */
  blockInternalRanges?: boolean;
  /** custom request policy callback */
  isRequestAllowed?: HttpHooks["isRequestAllowed"];
  /** custom ip policy callback */
  isIpAllowed?: HttpHooks["isIpAllowed"];

  /** request head hook */
  onRequestHead?: HttpHooks["onRequestHead"];
  /** buffered request hook */
  onRequest?: HttpHooks["onRequest"];

  /** response hook */
  onResponse?: HttpHooks["onResponse"];
};

export type CreateHttpHooksResult = {
  /** http hook implementation */
  httpHooks: HttpHooks;
  /** environment mapping for secret placeholders */
  env: Record<string, string>;
  /** resolved allowed hosts */
  allowedHosts: string[];
};

type SecretEntry = {
  name: string;
  placeholder: string;
  value: string;
  hosts: string[];
};

export function createHttpHooks(
  options: CreateHttpHooksOptions = {},
): CreateHttpHooksResult {
  const env: Record<string, string> = {};
  const secretEntries: SecretEntry[] = [];
  const blockInternalRanges = options.blockInternalRanges ?? true;

  for (const [name, secret] of Object.entries(options.secrets ?? {})) {
    const placeholder = `GONDOLIN_SECRET_${crypto.randomBytes(24).toString("hex")}`;
    env[name] = placeholder;
    secretEntries.push({
      name,
      placeholder,
      value: secret.value,
      hosts: secret.hosts.map(normalizeHostnamePattern),
    });
  }

  const allowedHosts = uniqueHosts([
    ...(options.allowedHosts ?? []),
    ...secretEntries.flatMap((entry) => entry.hosts),
  ]);

  const applySecretsToRequest = (request: HttpHookRequest): HttpHookRequest => {
    const hostname = getHostname(request);

    // Defense-in-depth: if the request already contains real secret values (eg: because
    // it was constructed from a redirected hop), make sure we still enforce per-secret
    // destination allowlists.
    assertSecretValuesAllowedForHost(
      request,
      hostname,
      secretEntries,
      options.replaceSecretsInQuery ?? false,
    );

    const headers = replaceSecretPlaceholdersInHeaders(
      request,
      hostname,
      secretEntries,
    );
    const url = replaceSecretPlaceholdersInUrlParameters(
      request.url,
      hostname,
      secretEntries,
      options.replaceSecretsInQuery ?? false,
    );

    return { ...request, url, headers };
  };

  const httpHooks: HttpHooks = {
    isRequestAllowed: async (request) => {
      if (options.isRequestAllowed) {
        return options.isRequestAllowed(request);
      }
      return true;
    },
    isIpAllowed: async (info) => {
      if (blockInternalRanges && isInternalAddress(info.ip)) {
        return false;
      }

      // We only use the hostname for allowlist checks.
      if (
        allowedHosts.length > 0 &&
        !matchesAnyHost(info.hostname, allowedHosts)
      ) {
        return false;
      }
      if (options.isIpAllowed) {
        return options.isIpAllowed(info);
      }
      return true;
    },
    onRequestHead: async (request) => {
      // Run user hooks first so any URL/Host rewrites are taken into account when
      // evaluating which secrets may be substituted.
      let nextRequest: HttpHookRequest = request;

      if (options.onRequestHead) {
        const updated = await options.onRequestHead(nextRequest);
        if (updated) {
          // `onRequestHead` may return extra control fields; preserve them.
          nextRequest = updated as unknown as HttpHookRequest;
        }
      }

      // qemu-net may call `httpHooks.onRequest` later (buffered bodies) or immediately
      // (eg: WebSocket handshake has no body). Preserve a copy of the head to feed into
      // `onRequest`.
      const requestForBodyHook = options.onRequest
        ? ({
            method: nextRequest.method,
            url: nextRequest.url,
            headers: nextRequest.headers,
            body: null,
          } satisfies HttpHookRequest)
        : null;

      const substituted = applySecretsToRequest(nextRequest);
      const out: any = {
        ...nextRequest,
        url: substituted.url,
        headers: substituted.headers,
      };
      if (requestForBodyHook && out.requestForBodyHook == null) {
        out.requestForBodyHook = requestForBodyHook;
      }

      return out;
    },
    onResponse: options.onResponse,
  };

  // Only install `onRequest` when the caller explicitly provides it; in qemu-net,
  // the presence of `httpHooks.onRequest` implies that request bodies must be buffered.
  if (options.onRequest) {
    httpHooks.onRequest = async (request) => {
      // Run the buffered hook first so rewrites can influence secret allowlist checks.
      let nextRequest: HttpHookRequest = request;

      const updated = await options.onRequest!(nextRequest);
      if (updated) nextRequest = updated;

      // Inject secrets at the last possible moment (after rewrites).
      nextRequest = applySecretsToRequest(nextRequest);

      return nextRequest;
    };
  }

  return { httpHooks, env, allowedHosts };
}

function getHostname(request: HttpHookRequest): string {
  try {
    return new URL(request.url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function assertSecretValuesAllowedForHost(
  request: HttpHookRequest,
  hostname: string,
  entries: SecretEntry[],
  checkQuery: boolean,
) {
  if (entries.length === 0) return;

  for (const entry of entries) {
    // If the destination is allowed for this secret, we don't care whether the secret
    // value already appears in the request.
    if (matchesAnyHost(hostname, entry.hosts)) continue;

    if (requestContainsSecretValueInHeaders(request.headers, entry)) {
      throw new HttpRequestBlockedError(
        `secret ${entry.name} not allowed for host: ${hostname || "unknown"}`,
      );
    }

    if (checkQuery && requestContainsSecretValueInQuery(request.url, entry)) {
      throw new HttpRequestBlockedError(
        `secret ${entry.name} not allowed for host: ${hostname || "unknown"}`,
      );
    }
  }
}

function requestContainsSecretValueInHeaders(
  headers: Record<string, string>,
  entry: SecretEntry,
): boolean {
  if (!entry.value) return false;

  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (!headerValue) continue;

    // Plaintext match (eg: Authorization: Bearer <token>)
    if (headerValue.includes(entry.value)) {
      return true;
    }

    // Basic auth uses base64 encoding
    if (/^(authorization|proxy-authorization)$/i.test(headerName)) {
      const decoded = decodeBasicAuth(headerValue);
      if (decoded && decoded.includes(entry.value)) {
        return true;
      }
    }
  }

  return false;
}

function decodeBasicAuth(value: string): string | null {
  const match = value.match(/^(Basic)(\s+)(\S+)(\s*)$/i);
  if (!match) return null;

  const token = match[3];
  try {
    return Buffer.from(token, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function requestContainsSecretValueInQuery(
  url: string,
  entry: SecretEntry,
): boolean {
  if (!entry.value) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (!parsed.search) return false;

  for (const [name, value] of parsed.searchParams.entries()) {
    if (name.includes(entry.value) || value.includes(entry.value)) {
      return true;
    }
  }

  return false;
}

function replaceSecretPlaceholdersInHeaders(
  request: HttpHookRequest,
  hostname: string,
  entries: SecretEntry[],
): Record<string, string> {
  if (entries.length === 0) return request.headers;

  const headers: Record<string, string> = { ...request.headers };

  for (const [headerName, value] of Object.entries(headers)) {
    let updated = value;

    // Plaintext placeholder replacement (eg: `Authorization: Bearer $TOKEN`).
    updated = replaceSecretPlaceholdersInString(updated, hostname, entries);

    // Basic auth uses base64 encoding of `username:password`, so placeholders
    // won't appear in the header value directly.
    updated = replaceBasicAuthSecretPlaceholders(
      headerName,
      updated,
      hostname,
      entries,
    );

    headers[headerName] = updated;
  }

  return headers;
}

function replaceSecretPlaceholdersInUrlParameters(
  url: string,
  hostname: string,
  entries: SecretEntry[],
  enabled: boolean,
): string {
  if (!enabled || entries.length === 0) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (!parsed.search) return url;

  const updatedParams = new URLSearchParams();
  let changed = false;

  for (const [name, value] of parsed.searchParams.entries()) {
    const updatedName = replaceSecretPlaceholdersInString(
      name,
      hostname,
      entries,
    );
    const updatedValue = replaceSecretPlaceholdersInString(
      value,
      hostname,
      entries,
    );
    if (updatedName !== name || updatedValue !== value) changed = true;
    updatedParams.append(updatedName, updatedValue);
  }

  if (!changed) return url;

  const nextSearch = updatedParams.toString();
  parsed.search = nextSearch ? `?${nextSearch}` : "";
  return parsed.toString();
}

function replaceBasicAuthSecretPlaceholders(
  headerName: string,
  headerValue: string,
  hostname: string,
  entries: SecretEntry[],
): string {
  // Only touch request headers that are expected to carry credentials.
  if (!/^(authorization|proxy-authorization)$/i.test(headerName)) {
    return headerValue;
  }

  const match = headerValue.match(/^(Basic)(\s+)(\S+)(\s*)$/i);
  if (!match) return headerValue;

  const scheme = match[1];
  const whitespace = match[2];
  const token = match[3];
  const trailing = match[4] ?? "";

  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64").toString("utf8");
  } catch {
    return headerValue;
  }

  const updatedDecoded = replaceSecretPlaceholdersInString(
    decoded,
    hostname,
    entries,
  );
  if (updatedDecoded === decoded) return headerValue;

  const updatedToken = Buffer.from(updatedDecoded, "utf8").toString("base64");
  return `${scheme}${whitespace}${updatedToken}${trailing}`;
}

function replaceSecretPlaceholdersInString(
  value: string,
  hostname: string,
  entries: SecretEntry[],
): string {
  let updated = value;

  for (const entry of entries) {
    if (!updated.includes(entry.placeholder)) continue;
    assertSecretAllowedForHost(entry, hostname);
    updated = replaceAll(updated, entry.placeholder, entry.value);
  }

  return updated;
}

function assertSecretAllowedForHost(
  entry: SecretEntry,
  hostname: string,
): void {
  if (matchesAnyHost(hostname, entry.hosts)) return;
  throw new HttpRequestBlockedError(
    `secret ${entry.name} not allowed for host: ${hostname || "unknown"}`,
  );
}

function matchesAnyHost(hostname: string, patterns: string[]): boolean {
  const normalized = hostname.toLowerCase();
  return patterns.some((pattern) => matchHostname(normalized, pattern));
}

function normalizeHostnamePattern(pattern: string): string {
  return pattern.trim().toLowerCase();
}

function matchHostname(hostname: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === "*") return true;

  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(hostname);
}

function isInternalAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const octets = ip.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const [a, b] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 255) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const hextets = parseIPv6Hextets(ip);
  if (!hextets) return false;

  const isAllZero = hextets.every((value) => value === 0);
  const isLoopback =
    hextets.slice(0, 7).every((value) => value === 0) && hextets[7] === 1;
  if (isAllZero || isLoopback) return true;

  if ((hextets[0] & 0xfe00) === 0xfc00) return true;
  if ((hextets[0] & 0xffc0) === 0xfe80) return true;

  const mapped = extractIPv4Mapped(hextets);
  if (mapped && isPrivateIPv4(mapped)) return true;

  return false;
}

function uniqueHosts(hosts: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const host of hosts) {
    const normalized = normalizeHostnamePattern(host);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function replaceAll(
  value: string,
  search: string,
  replacement: string,
): string {
  if (!search) return value;
  return value.split(search).join(replacement);
}
