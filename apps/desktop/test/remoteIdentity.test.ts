import { describe, expect, it } from "vitest";
import { formatRemoteId } from "../src/remoteIdentity";

describe("shareable Remote ID", () => {
  it("formats a server-assigned nine-digit ID", () => {
    expect(formatRemoteId("834951220")).toBe("834 951 220");
    expect(formatRemoteId("834 951 220")).toBe("834 951 220");
    expect(formatRemoteId("001002003")).toBe("001 002 003");
  });
  it("never treats a public key or malformed identity as a shareable ID", () => {
    for (const value of [null, undefined, "YSCZZOYIEdfwligIFYzdiCh57fuWhhExN/glBA=", "abcdefghi", "12345678", "1234567890", "123-456-789"]) {
      expect(formatRemoteId(value)).toBeNull();
    }
  });
});
