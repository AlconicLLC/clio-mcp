/**
 * node-postgres currently treats sslmode=prefer|require|verify-ca as verify-full,
 * and will switch those names to weaker libpq semantics in pg v9.
 * Rewrite them so hosted Neon URLs keep certificate and hostname checks.
 */
const QUERY_SSLMODE = /([?&]sslmode=)(?:prefer|require|verify-ca)(?=$|[&#])/gi;
const KEYWORD_SSLMODE = /(^|\s)sslmode=(?:prefer|require|verify-ca)(?=$|\s)/gi;

export function withVerifyFullSsl(databaseUrl: string): string {
  return databaseUrl
    .replace(QUERY_SSLMODE, "$1verify-full")
    .replace(KEYWORD_SSLMODE, "$1sslmode=verify-full");
}
