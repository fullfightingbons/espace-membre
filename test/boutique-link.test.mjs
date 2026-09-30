import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../public/assets/app.js", import.meta.url), "utf8");

// Ces tests sont volontairement au niveau du source (comme wishlist-services) :
// app.js est un script navigateur, pas un module importable.
describe("lien vers la boutique (tenue offerte aux Membres du Bureau)", () => {
  it("transmet le jeton membre dans le fragment #membre=, attendu par la boutique", () => {
    expect(appSource).toContain("`${API.boutique}/#membre=${encodeURIComponent(token)}`");
  });

  it("ne pose jamais le jeton dans un href : l'adresse est construite au clic", () => {
    expect(appSource).not.toMatch(/href:\s*buildBoutiqueUrl/);
    expect(appSource).not.toMatch(/href:\s*`[^`]*#membre=/);
    expect(appSource).toContain("window.location.href = buildBoutiqueUrl()");
  });

  it("tous les liens vers la boutique passent par bindBoutiqueLink", () => {
    // Navigation croisée + « Voir la boutique » (favoris et commandes).
    expect(appSource).toContain("label === 'Boutique' ? bindBoutiqueLink(link) : link");
    const seeShop = appSource.match(/bindBoutiqueLink\(el\('a', \{ class: 'link-quiet', href: API\.boutique/g) || [];
    expect(seeShop.length).toBe(2);
    // Aucun autre lien direct vers API.boutique n'échappe au dispositif.
    const rawLinks = appSource.match(/el\('a', \{[^}]*href: API\.boutique/g) || [];
    expect(rawLinks.length).toBe(seeShop.length);
  });
});
