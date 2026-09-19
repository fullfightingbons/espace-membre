// Garde-fou minimal sur public/.well-known/assetlinks.json (vérification
// Digital Asset Links de l'APK Android / Trusted Web Activity) : le fichier
// doit rester un JSON valide qui déclare le bon package. Les empreintes SHA-256
// sont écrites par scripts/make-keystore.sh — on ne les valide volontairement
// pas ici, pour ne pas bloquer le déploiement du Worker avant la création de la clé.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("../public/.well-known/assetlinks.json", import.meta.url), "utf8");

describe("assetlinks.json", () => {
  it("is valid JSON and targets the Android package", () => {
    const data = JSON.parse(raw);
    expect(Array.isArray(data)).toBe(true);
    const statement = data[0];
    expect(statement.relation).toContain("delegate_permission/common.handle_all_urls");
    expect(statement.target.namespace).toBe("android_app");
    expect(statement.target.package_name).toBe("fr.americanfullfightingbons.espacemembre");
    expect(Array.isArray(statement.target.sha256_cert_fingerprints)).toBe(true);
  });
});
