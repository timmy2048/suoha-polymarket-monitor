import { describe, expect, it } from "vitest";
import { getProxyUrlFromEnv, parseWindowsProxyServer } from "../src/http.js";

describe("HTTP proxy detection", () => {
  it("prefers explicit HTTPS proxy environment variables", () => {
    expect(
      getProxyUrlFromEnv({
        HTTPS_PROXY: "http://127.0.0.1:7897",
        HTTP_PROXY: "http://127.0.0.1:8888"
      })
    ).toBe("http://127.0.0.1:7897");
  });

  it("parses plain Windows proxy host and port", () => {
    expect(parseWindowsProxyServer("127.0.0.1:7897")).toBe("http://127.0.0.1:7897");
  });

  it("parses protocol-specific Windows proxy settings", () => {
    expect(parseWindowsProxyServer("http=127.0.0.1:7897;https=127.0.0.1:7898")).toBe(
      "http://127.0.0.1:7898"
    );
  });
});
