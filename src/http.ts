import { execFileSync } from "node:child_process";
import { fetch as undiciFetch, ProxyAgent } from "undici";

export function createDefaultFetch(env: NodeJS.ProcessEnv = process.env): typeof fetch {
  const proxyUrl = getProxyUrl(env);
  if (!proxyUrl) {
    return fetch;
  }

  const dispatcher = new ProxyAgent(proxyUrl);
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher
    } as Parameters<typeof undiciFetch>[1] & { dispatcher: ProxyAgent })) as typeof fetch;
}

export function getProxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return getProxyUrlFromEnv(env) ?? getWindowsProxyUrl();
}

export function getProxyUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return (
    env.HTTPS_PROXY ??
    env.https_proxy ??
    env.ALL_PROXY ??
    env.all_proxy ??
    env.HTTP_PROXY ??
    env.http_proxy ??
    undefined
  );
}

export function parseWindowsProxyServer(proxyServer: string | undefined): string | undefined {
  if (!proxyServer) {
    return undefined;
  }

  const trimmed = proxyServer.trim();
  if (!trimmed) {
    return undefined;
  }

  const protocolSpecific = parseProtocolSpecificProxy(trimmed);
  const proxy = protocolSpecific ?? trimmed;
  return proxy.includes("://") ? proxy : `http://${proxy}`;
}

function getWindowsProxyUrl(): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  try {
    const proxyEnabled = readRegistryValue("ProxyEnable");
    if (!proxyEnabled || !/(0x1|\s1)$/i.test(proxyEnabled.trim())) {
      return undefined;
    }

    return parseWindowsProxyServer(readRegistryValue("ProxyServer"));
  } catch {
    return undefined;
  }
}

function readRegistryValue(name: string): string | undefined {
  const output = execFileSync(
    "reg",
    ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", name],
    { encoding: "utf8", windowsHide: true }
  );
  const line = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.startsWith(name));

  if (!line) {
    return undefined;
  }

  const parts = line.split(/\s{2,}/);
  return parts.at(-1);
}

function parseProtocolSpecificProxy(proxyServer: string): string | undefined {
  const entries = proxyServer
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [protocol, value] = entry.split("=");
      return { protocol: protocol?.toLowerCase(), value };
    });

  return entries.find((entry) => entry.protocol === "https")?.value ?? entries.find((entry) => entry.protocol === "http")?.value;
}
