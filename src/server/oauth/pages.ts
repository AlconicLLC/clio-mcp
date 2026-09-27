import type { Response } from "express";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** No scripts, no framing, nothing cached. Forms post only to this origin. */
function setPageHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // no-referrer makes browsers send `Origin: null` on the consent POST, which the origin check rejects.
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"
  );
}

const STYLE =
  "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f7f9;color:#1d2330;margin:0}" +
  "main{max-width:440px;margin:12vh auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.08)}" +
  "h1{font-size:20px;margin:0 0 16px}p{line-height:1.5;margin:0 0 12px}.host{font-weight:600}" +
  ".actions{display:flex;gap:12px;margin-top:24px}button{flex:1;font-size:15px;padding:10px;border-radius:8px;cursor:pointer}" +
  ".approve{background:#1f5eff;color:#fff;border:0}.deny{background:#fff;border:1px solid #c9ced8;color:#1d2330}" +
  ".note{font-size:13px;color:#5b6475}";

function layout(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
    `<style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function sendConsentPage(
  res: Response,
  p: { clientHost: string; redirectHost: string; serverHost: string; requestId: string; consentToken: string }
): void {
  setPageHeaders(res);
  res.status(200).type("html").send(layout("Connect Claude to Clio", `
<h1>Connect Claude to your Clio account?</h1>
<p><span class="host">${escapeHtml(p.clientHost)}</span> is asking to use Clio on your behalf through
<span class="host">${escapeHtml(p.serverHost)}</span>.</p>
<p>If you continue, you will sign in on Clio's own page. Claude will then be able to read and, where
permitted, update the Clio matters, contacts, documents and calendar that your Clio account can access.</p>
<p class="note">After sign-in you will be returned to ${escapeHtml(p.redirectHost)}. If you did not just click
Connect in Claude, choose Cancel.</p>
<form method="post" action="/oauth/consent">
<input type="hidden" name="request_id" value="${escapeHtml(p.requestId)}">
<input type="hidden" name="consent_token" value="${escapeHtml(p.consentToken)}">
<div class="actions">
<button class="deny" type="submit" name="decision" value="deny">Cancel</button>
<button class="approve" type="submit" name="decision" value="approve">Continue to Clio</button>
</div>
</form>`));
}

export function sendMessagePage(res: Response, status: number, title: string, message: string): void {
  setPageHeaders(res);
  res.status(status).type("html").send(layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`));
}
