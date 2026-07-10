export interface Env {
  ASSETS: Fetcher;
}

// Mêmes en-têtes de sécurité que les autres Workers du projet (site, gestion,
// calendrier, boutique) — cf. leurs commentaires respectifs sur pourquoi
// chacun de ces en-têtes existe. connect-src liste les trois APIs que ce
// front appelle en cross-origin (gestion pour l'identité/les documents,
// boutique pour les commandes, calendrier pour les inscriptions) ; sans ces
// domaines ici, le navigateur bloquerait silencieusement tous les appels
// fetch() de app.js.
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' https://gestion.americanfullfightingbons.fr https://boutique.americanfullfightingbons.fr https://calendrier.americanfullfightingbons.fr https://americanfullfightingbons.fr",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      headers.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
