import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../public/assets/app.js", import.meta.url), "utf8");

describe("dashboard integrations", () => {
  it("loads and removes wishlist items with the authenticated member token", () => {
    expect(appSource).toContain("boutiqueApi('/api/wishlist')");
    expect(appSource).toContain("boutiqueApi('/api/wishlist/' + it.product_id, { method: 'DELETE' })");
    expect(appSource).not.toContain("/api/wishlist?email=");
    expect(appSource).not.toContain("auth: false })).then((wishRes)");
  });

  it("shows health status for connected services", () => {
    expect(appSource).toContain("const SERVICE_HEALTHCHECKS");
    expect(appSource).toContain("function renderServicesStatusSection");
    expect(appSource).toContain("refreshServicesStatus(servicesSection)");
  });
});
