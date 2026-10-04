import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesktopHub } from "../src/DesktopHub";

function renderIdentity(remoteId: string) {
  return renderToStaticMarkup(createElement(DesktopHub, {
    activeTab: "home", onTabChange: () => {}, remoteId,
    identityError: "", enrolling: false, onEnroll: async () => {},
    deviceName: "Test host", isElevated: false, monitorCount: 1, isNative: true,
    copied: false, copyError: "", onCopyId: () => {}, remoteIdInput: "",
    onRemoteIdChange: () => {}, onConnect: () => {}, connecting: false,
    connectionError: "", recentDevices: [],
  }));
}

describe("Remote ID share card", () => {
  it("does not leak a public key and offers registration instead", () => {
    const publicKey = "YSCZZOYIEdfwligIFYzdiCh57fuWhhExN/glBA=";
    const html = renderIdentity(publicKey);
    expect(html).not.toContain(publicKey);
    expect(html).toContain("Registration required");
    expect(html).toMatch(/class="copy-id-button" disabled=""/);
    expect(html).toContain("Get Remote ID");
  });

  it("shows a registered nine-digit ID and enables copying", () => {
    const html = renderIdentity("834951220");
    expect(html).toContain("834 951 220");
    expect(html).not.toMatch(/class="copy-id-button" disabled/);
    expect(html).toContain("Registered");
    expect(html).not.toContain("Get Remote ID");
  });
});
