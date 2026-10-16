import { expect, test } from "vitest";
import { loopbackUrl } from "./loopback";

test("an e2e test takes a BB on this machine, at any port", () => {
  expect(loopbackUrl("BB_E2E_URL", "http://127.0.0.1:4331")).toBe("http://127.0.0.1:4331");
  expect(loopbackUrl("BB_E2E_URL", "http://localhost:4331/")).toBe("http://localhost:4331");
  expect(loopbackUrl("BB_E2E_URL", "http://[::1]:4331")).toBe("http://[::1]:4331");
});

test("an e2e test refuses a BB elsewhere", () => {
  for (const url of ["https://bb.example.com", "http://10.0.0.5:4331", "http://127.0.0.1.example.com:4331", "http://localhost@example.com:4331", "http://127.0.0.1:4331/plugins"]) {
    expect(() => loopbackUrl("BB_E2E_URL", url), url).toThrow("BB_E2E_URL must be a test BB on this machine");
  }
});
