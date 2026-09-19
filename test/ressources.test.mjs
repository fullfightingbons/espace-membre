// Garde-fous sur la section « Ressources du club » du tableau de bord
// (banderole des techniques Full Contact) : les fichiers référencés par
// app.js doivent exister dans public/ — un chemin qui dérive ou un fichier
// oublié au commit donnerait un aperçu cassé sans qu'aucune autre vérif ne le
// détecte — et la section doit bien être posée dans la colonne latérale.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";

const appSource = readFileSync(new URL("../public/assets/app.js", import.meta.url), "utf8");
const MAX_ASSET_BYTES = 25 * 1024 * 1024; // limite d'un asset Cloudflare Workers

describe("ressources du club — banderole des techniques", () => {
  for (const path of [
    "/assets/docs/banderole-techniques-full-contact.pdf",
    "/assets/docs/banderole-techniques-full-contact.webp",
  ]) {
    it(`référence ${path} et le fichier existe (< 25 Mio)`, () => {
      expect(appSource).toContain(path);
      const file = new URL(`../public${path}`, import.meta.url);
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).size).toBeGreaterThan(0);
      expect(statSync(file).size).toBeLessThan(MAX_ASSET_BYTES);
    });
  }

  it("le PDF est bien un PDF", () => {
    const head = readFileSync(new URL("../public/assets/docs/banderole-techniques-full-contact.pdf", import.meta.url)).subarray(0, 5).toString("latin1");
    expect(head).toBe("%PDF-");
  });

  it("pose la section dans le tableau de bord", () => {
    expect(appSource).toContain("colSide.appendChild(renderRessourcesSection())");
  });
});
