import assert from "node:assert/strict";
import test from "node:test";

import { VM } from "../src/vm";
import { HttpRequestBlockedError } from "../src/qemu-net";
import { createHttpHooks } from "../src/http-hooks";

const url = process.env.WS_URL;
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 15000);
const httpUrl = process.env.WS_HTTP_URL ?? "http://icanhazip.com";
const httpsUrl = process.env.WS_HTTPS_URL ?? "https://icanhazip.com";
const token = process.env.ELWING_TOKEN ?? process.env.SANDBOX_WS_TOKEN;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("timeout waiting for response"));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertFetchOutput(output: string, stderr: string) {
  const lines = output.trim().split("\n");
  const httpIndex = lines.findIndex((line) => line.trim() === "HTTP");
  const httpsIndex = lines.findIndex((line) => line.trim() === "HTTPS");
  if (httpIndex === -1 || httpsIndex === -1) {
    const detail = stderr.trim() ? `\n${stderr.trim()}` : "";
    assert.fail(`missing http/https output: ${output.trim()}${detail}`);
  }
  const httpValue = lines[httpIndex + 1]?.trim();
  const httpsValue = lines[httpsIndex + 1]?.trim();
  if (!httpValue || !httpsValue) {
    const detail = stderr.trim() ? `\n${stderr.trim()}` : "";
    assert.fail(`empty http/https response: ${output.trim()}${detail}`);
  }
}

test("ws http/https fetch", { timeout: timeoutMs }, async () => {
  const vm = new VM({ url: url ?? undefined, token: token ?? undefined });

  try {
    const result = await withTimeout(
      vm.exec([
        "python3",
        "-c",
        `import sys,urllib.request;\n` +
          `print('HTTP');\n` +
          `print(urllib.request.urlopen('${httpUrl}', timeout=10).read().decode().strip());\n` +
          `print('HTTPS');\n` +
          `print(urllib.request.urlopen('${httpsUrl}', timeout=10).read().decode().strip());\n`,
      ]),
      timeoutMs
    );

    // stdout/stderr are now strings
    const output = result.stdout;
    const stderr = result.stderr;

    assert.equal(
      result.exitCode,
      0,
      stderr.trim() ? `unexpected exit code: ${result.exitCode}\n${stderr.trim()}` : undefined
    );

    assertFetchOutput(output, stderr);
  } finally {
    await vm.stop();
  }
});

test("ws fetch hook blocks requests", { timeout: timeoutMs, skip: Boolean(url) }, async () => {
  const baseFetch = fetch;
  const vm = new VM({
    token: token ?? undefined,
    fetch: async (input, init) => {
      const target =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const hostname = new URL(target).hostname;
      if (hostname !== "example.com") {
        throw new HttpRequestBlockedError("blocked by test", 451, "Blocked");
      }
      return baseFetch(input, init);
    },
  });

  try {
    const script = [
      "import urllib.request, urllib.error",
      "def fetch(url):",
      "    try:",
      "        return urllib.request.urlopen(url, timeout=10).read().decode('utf-8', 'ignore')",
      "    except urllib.error.HTTPError as e:",
      "        return f'HTTP {e.code}'",
      "    except Exception as e:",
      "        return f'ERROR {type(e).__name__}'",
      "print('EXAMPLE_COM')",
      "print('OK' if 'Example Domain' in fetch('http://example.com') else 'BAD')",
      "print('EXAMPLE_ORG')",
      "print(fetch('http://example.org'))",
    ].join("\n");

    const result = await withTimeout(
      vm.exec(["python3", "-c", script]),
      timeoutMs
    );

    // stdout/stderr are now strings
    const output = result.stdout.trim().split("\n");
    const stderr = result.stderr;

    assert.equal(
      result.exitCode,
      0,
      stderr.trim() ? `unexpected exit code: ${result.exitCode}\n${stderr.trim()}` : undefined
    );

    const exampleComIndex = output.indexOf("EXAMPLE_COM");
    const exampleOrgIndex = output.indexOf("EXAMPLE_ORG");

    assert.notEqual(exampleComIndex, -1, `missing EXAMPLE_COM output: ${output.join("\n")}`);
    assert.notEqual(exampleOrgIndex, -1, `missing EXAMPLE_ORG output: ${output.join("\n")}`);
    assert.equal(output[exampleComIndex + 1], "OK");
    assert.equal(output[exampleOrgIndex + 1], "HTTP 451");
  } finally {
    await vm.stop();
  }
});

test("ws isAllowed blocks private ipv4", { timeout: timeoutMs, skip: Boolean(url) }, async () => {
  const isPrivateIPv4 = (ip: string) => {
    const parts = ip.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return false;
    }
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    return false;
  };

  const seenIps: string[] = [];
  const vm = new VM({
    token: token ?? undefined,
    httpHooks: {
      isAllowed: (info) => {
        seenIps.push(info.ip);
        return !isPrivateIPv4(info.ip);
      },
    },
  });

  try {
    const script = [
      "import urllib.request, urllib.error",
      "def fetch(url):",
      "    try:",
      "        return urllib.request.urlopen(url, timeout=5).read().decode('utf-8', 'ignore')",
      "    except urllib.error.HTTPError as e:",
      "        return f'HTTP {e.code}'",
      "    except Exception as e:",
      "        return f'ERROR {type(e).__name__}'",
      "print('PRIVATE_GW')",
      "print(fetch('http://192.168.127.1'))",
      "print('PRIVATE_10')",
      "print(fetch('http://10.0.0.1'))",
    ].join("\n");

    const result = await withTimeout(vm.exec(["python3", "-c", script]), timeoutMs);

    // stdout/stderr are now strings
    const output = result.stdout.trim().split("\n");
    const stderr = result.stderr;

    assert.equal(
      result.exitCode,
      0,
      stderr.trim() ? `unexpected exit code: ${result.exitCode}\n${stderr.trim()}` : undefined
    );

    const gwIndex = output.indexOf("PRIVATE_GW");
    const privateIndex = output.indexOf("PRIVATE_10");

    assert.notEqual(gwIndex, -1, `missing PRIVATE_GW output: ${output.join("\n")}`);
    assert.notEqual(privateIndex, -1, `missing PRIVATE_10 output: ${output.join("\n")}`);
    assert.equal(output[gwIndex + 1], "HTTP 403");
    assert.equal(output[privateIndex + 1], "HTTP 403");
    assert.ok(seenIps.includes("192.168.127.1"), `missing 192.168.127.1 in isAllowed: ${seenIps.join(", ")}`);
    assert.ok(seenIps.includes("10.0.0.1"), `missing 10.0.0.1 in isAllowed: ${seenIps.join(", ")}`);
  } finally {
    await vm.stop();
  }
});


test("ws redirect blocks secret leakage", { timeout: timeoutMs, skip: Boolean(url) }, async () => {
  const secretValue = "sk-test-secret";
  const requests: Array<{ url: string; auth: string | null }> = [];

  const fetchStub: typeof fetch = async (input, init) => {
    const urlString =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers = new Headers(init?.headers ?? (typeof input === "object" ? input.headers : undefined));
    const auth = headers.get("authorization");
    requests.push({ url: urlString, auth });

    if (urlString.startsWith("http://example.com")) {
      return new Response(null, {
        status: 302,
        headers: { location: "http://example.org/next" },
      });
    }

    if (urlString.startsWith("http://example.org")) {
      return new Response("OK", { status: 200 });
    }

    return new Response("Unexpected", { status: 500 });
  };

  const { httpHooks, env } = createHttpHooks({
    allowedHosts: ["example.com", "example.org"],
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: secretValue,
      },
    },
  });

  const vm = new VM({
    token: token ?? undefined,
    fetch: fetchStub,
    httpHooks,
    env,
  });

  try {
    const script = [
      "import os",
      "import urllib.request, urllib.error",
      "def fetch(url):",
      "    try:",
      "        req = urllib.request.Request(url)",
      "        req.add_header('Authorization', 'Bearer ' + (os.environ.get('API_KEY') or ''))",
      "        return urllib.request.urlopen(req, timeout=5).read().decode('utf-8', 'ignore')",
      "    except urllib.error.HTTPError as e:",
      "        return f'HTTP {e.code}'",
      "    except Exception as e:",
      "        return f'ERROR {type(e).__name__}'",
      "print(fetch('http://example.com/start'))",
    ].join("\n");

    const result = await withTimeout(vm.exec(["python3", "-c", script]), timeoutMs);

    assert.equal(result.exitCode, 0, result.stderr.trim() || undefined);
    assert.equal(result.stdout.trim(), "HTTP 403");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://example.com/start");
    assert.equal(requests[0].auth, `Bearer ${secretValue}`);
  } finally {
    await vm.stop();
  }
});

test("exec result helpers", { timeout: timeoutMs }, async () => {
  const vm = new VM({ url: url ?? undefined, token: token ?? undefined });

  try {
    // Test .lines() helper
    const lsResult = await vm.exec(["sh", "-c", "echo -e 'one\\ntwo\\nthree'"]);
    const lines = lsResult.lines();
    assert.deepEqual(lines, ["one", "two", "three"]);

    // Test .json() helper
    const jsonResult = await vm.exec(["sh", "-c", `echo '{"foo": "bar"}'`]);
    const parsed = jsonResult.json<{ foo: string }>();
    assert.equal(parsed.foo, "bar");

    // Test .ok helper
    const okResult = await vm.exec(["true"]);
    assert.equal(okResult.ok, true);

    const failResult = await vm.exec(["false"]);
    assert.equal(failResult.ok, false);
  } finally {
    await vm.stop();
  }
});

test("exec streaming with async iterator", { timeout: timeoutMs }, async () => {
  const vm = new VM({ url: url ?? undefined, token: token ?? undefined });

  try {
    const chunks: string[] = [];
    const proc = vm.exec(["sh", "-c", "echo one; echo two; echo three"]);

    for await (const chunk of proc) {
      chunks.push(chunk);
    }

    const combined = chunks.join("");
    assert.ok(combined.includes("one"), `missing 'one' in output: ${combined}`);
    assert.ok(combined.includes("two"), `missing 'two' in output: ${combined}`);
    assert.ok(combined.includes("three"), `missing 'three' in output: ${combined}`);
  } finally {
    await vm.stop();
  }
});

test("exec with stdin", { timeout: timeoutMs }, async () => {
  const vm = new VM({ url: url ?? undefined, token: token ?? undefined });

  try {
    // Test stdin as string
    const result = await vm.exec(["cat"], { stdin: "hello world" });
    assert.equal(result.stdout.trim(), "hello world");
  } finally {
    await vm.stop();
  }
});
