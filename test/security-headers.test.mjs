// Tests unitaires pour src/index.ts (le seul code applicatif de ce Worker :
// un proxy vers ASSETS qui ajoute des en-têtes de sécurité).
// Lancer avec : npx vitest run (après `npm install -D vitest`)
//
// Ce Worker n'avait aucun test, contrairement aux 5 autres apps de
// l'écosystème AFFBC. Sa seule responsabilité — poser les bons en-têtes de
// sécurité sur toute réponse servie — mérite d'être vérifiée : une régression
// silencieuse ici retirerait la CSP ou X-Frame-Options de tout le front.

import { describe, it, expect } from "vitest";
import worker from "../src/index.ts";

function fakeAssetsEnv(responseInit = {}) {
  return {
    ASSETS: {
      async fetch() {
        return new Response("<html>ok</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
          ...responseInit,
        });
      },
    },
  };
}

describe("worker fetch — security headers", () => {
  it("adds all expected security headers to the ASSETS response", async () => {
    const env = fakeAssetsEnv();
    const res = await worker.fetch(new Request("https://espace-membre.example/"), env);

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("Permissions-Policy")).toContain("geolocation=()");
  });

  it("scopes the CSP connect-src to the three known cross-origin APIs", async () => {
    const env = fakeAssetsEnv();
    const res = await worker.fetch(new Request("https://espace-membre.example/"), env);
    const csp = res.headers.get("Content-Security-Policy");

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("https://gestion.americanfullfightingbons.fr");
    expect(csp).toContain("https://boutique.americanfullfightingbons.fr");
    expect(csp).toContain("https://calendrier.americanfullfightingbons.fr");
    // frame-ancestors 'none' est ce qui empêche l'espace membre d'être
    // embarqué dans un <iframe> tiers (clickjacking).
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("preserves the underlying status and body from ASSETS", async () => {
    const env = fakeAssetsEnv({ status: 404 });
    const res = await worker.fetch(new Request("https://espace-membre.example/missing"), env);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<html>ok</html>");
  });

  it("does not let the ASSETS response override a security header", async () => {
    // Si un jour l'asset statique (ou un futur changement de ASSETS) renvoie
    // son propre X-Frame-Options, le Worker doit quand même imposer DENY.
    const env = fakeAssetsEnv({ headers: { "X-Frame-Options": "SAMEORIGIN" } });
    const res = await worker.fetch(new Request("https://espace-membre.example/"), env);

    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
