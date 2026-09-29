import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// On n'exécute pas app.js entier (c'est un SPA qui touche `window`/`document`
// dès le chargement) : on extrait juste les fonctions pures qu'on modifie ici,
// par appariement d'accolades, pour tester leur vrai comportement plutôt que
// de simples correspondances de texte comme le fait le reste de ce dossier.
// Un extrait manquant fait échouer beforeAll avec un message explicite,
// plutôt que d'exécuter silencieusement une ancienne copie de la fonction.
const appSource = readFileSync(new URL("../public/assets/app.js", import.meta.url), "utf8");

function extractFunction(source, name) {
  const needle = `function ${name}(`;
  const start = source.indexOf(needle);
  if (start === -1) throw new Error(`Fonction "${name}" introuvable dans app.js — a-t-elle été renommée ?`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Accolade fermante de "${name}" introuvable`);
}

function extractConst(source, name) {
  const m = new RegExp(`const ${name}\\s*=\\s*'([^']*)'`).exec(source);
  if (!m) throw new Error(`Constante "${name}" introuvable dans app.js`);
  return m[1];
}

let sandbox;
let RENEWAL_URL;

beforeAll(() => {
  RENEWAL_URL = extractConst(appSource, "RENEWAL_URL");
  const code = [
    `const RENEWAL_URL = ${JSON.stringify(RENEWAL_URL)};`,
    extractFunction(appSource, "cleanAddressForPrefill"),
    extractFunction(appSource, "buildRenewalUrl"),
    extractFunction(appSource, "isCotisationOk"),
    extractFunction(appSource, "isAdhesionExpired"),
    extractFunction(appSource, "needsRenewal"),
  ].join("\n\n");
  sandbox = { btoa, TextEncoder, console };
  vm.createContext(sandbox);
  vm.runInContext(
    code + "\nthis.cleanAddressForPrefill = cleanAddressForPrefill; this.buildRenewalUrl = buildRenewalUrl; " +
      "this.isCotisationOk = isCotisationOk; this.isAdhesionExpired = isAdhesionExpired; this.needsRenewal = needsRenewal;",
    sandbox,
  );
});

function decodePrefill(url) {
  const token = new URL(url).searchParams.get("prefill");
  const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

describe("buildRenewalUrl — préremplissage du renouvellement", () => {
  it("transmet le sexe quand il vaut F ou M", () => {
    const prefill = decodePrefill(sandbox.buildRenewalUrl({ nom: "Grallien", prenom: "Laurent", sexe: "M" }));
    expect(prefill.sexe).toBe("M");
  });

  it("omet le sexe s'il est absent, null ou invalide (fiches créées avant ce champ)", () => {
    for (const sexe of [undefined, null, "", "autre"]) {
      const prefill = decodePrefill(sandbox.buildRenewalUrl({ nom: "X", prenom: "Y", sexe }));
      expect(prefill.sexe).toBeUndefined();
    }
  });

  it("retire un « Néant » de fin d'adresse (avec ou sans accent/casse, séparé par virgule, tiret ou espace)", () => {
    for (const adresse of ["12 rue des Lilas, Néant", "12 rue des Lilas Neant", "12 rue des Lilas - NEANT", "12 rue des Lilas néant"]) {
      const prefill = decodePrefill(sandbox.buildRenewalUrl({ adresse }));
      expect(prefill.address1).toBe("12 rue des Lilas");
    }
  });

  it("ne retire pas de vraie fin d'adresse qui ne serait pas « Néant »", () => {
    const prefill = decodePrefill(sandbox.buildRenewalUrl({ adresse: "3 impasse Néanthal" }));
    expect(prefill.address1).toBe("3 impasse Néanthal");
  });

  it("laisse address1 vide (undefined) quand le champ ne contient que « Néant », sans rien devant", () => {
    const prefill = decodePrefill(sandbox.buildRenewalUrl({ adresse: "  Néant  " }));
    expect(prefill.address1).toBeUndefined();
  });

  it("retombe sur le formulaire nu si le préremplissage échoue (ex. valeur non sérialisable en JSON)", () => {
    // JSON.stringify lève sur un BigInt (contrairement à un objet circulaire,
    // que String() aplatirait avant même d'atteindre JSON.stringify).
    expect(sandbox.buildRenewalUrl({ email: 10n })).toBe(RENEWAL_URL);
  });
});

describe("isAdhesionExpired / needsRenewal / isCotisationOk", () => {
  const NOW = new Date("2026-09-28T10:00:00");

  it("considère une adhésion expirée le lendemain de sa date de fin, pas le jour même", () => {
    expect(sandbox.isAdhesionExpired({ date_fin_adhesion: "2026-09-28" }, NOW)).toBe(false);
    expect(sandbox.isAdhesionExpired({ date_fin_adhesion: "2026-09-27" }, NOW)).toBe(true);
    expect(sandbox.isAdhesionExpired({ date_fin_adhesion: "2026-09-29" }, NOW)).toBe(false);
  });

  it("ne conclut jamais à une expiration si la date est absente ou illisible", () => {
    for (const date_fin_adhesion of [undefined, null, "", "pas une date"]) {
      expect(sandbox.isAdhesionExpired({ date_fin_adhesion }, NOW)).toBe(false);
    }
  });

  it("traite « Gratuit » (tarif Membres du Bureau) comme une cotisation à jour", () => {
    expect(sandbox.isCotisationOk("Gratuit")).toBe(true);
    expect(sandbox.isCotisationOk("gratuit")).toBe(true);
  });

  it("needsRenewal se déclenche sur l'échéance dépassée même si le paiement affiche toujours « Payé »", () => {
    // La fiche garde le règlement de la saison passée après l'échéance — se
    // fier au seul champ paiement masquerait un renouvellement nécessaire.
    expect(sandbox.needsRenewal({ paiement: "Payé", date_fin_adhesion: "2026-09-27" }, NOW)).toBe(true);
  });

  it("needsRenewal se déclenche aussi sur un impayé, même avec une échéance encore valide", () => {
    expect(sandbox.needsRenewal({ paiement: "En attente", date_fin_adhesion: "2027-06-30" }, NOW)).toBe(true);
  });

  it("needsRenewal est faux quand le paiement est à jour ET l'échéance non dépassée", () => {
    expect(sandbox.needsRenewal({ paiement: "Payé", date_fin_adhesion: "2027-06-30" }, NOW)).toBe(false);
    expect(sandbox.needsRenewal({ paiement: "Gratuit", date_fin_adhesion: "2027-06-30" }, NOW)).toBe(false);
  });
});
