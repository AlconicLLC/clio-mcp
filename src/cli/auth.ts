import { EXIT } from "./args.js";
import { AUTH_USAGE } from "./usage.js";
import { validateAuthEnv } from "../config/startupValidation.js";
import { getClioRegion } from "../utils/clioRegion.js";
import type { ClioTokens, ClioWhoAmI } from "../auth/clioOAuth.js";

export interface AuthDeps {
  env: NodeJS.ProcessEnv;
  now(): number;
  login(): Promise<ClioTokens>;
  whoAmI(accessToken: string): Promise<ClioWhoAmI>;
  stdout(text: string): void;
  stderr(text: string): void;
}

async function resolveDeps(overrides: Partial<AuthDeps>): Promise<AuthDeps> {
  const login =
    overrides.login ??
    (async () => {
      const oauth = await import("../auth/oauth.js");
      return oauth.isBrokerMode() ? oauth.runBrokerOAuthFlow() : oauth.runOAuthFlow();
    });
  const whoAmI = overrides.whoAmI ?? (async (token: string) => (await import("../auth/clioOAuth.js")).fetchClioWhoAmI(token));
  return {
    env: overrides.env ?? process.env,
    now: overrides.now ?? Date.now,
    login,
    whoAmI,
    stdout: overrides.stdout ?? ((text) => void process.stdout.write(text)),
    stderr: overrides.stderr ?? ((text) => void process.stderr.write(text)),
  };
}

function describeExpiry(expiresAt: number, now: number): string {
  const minutes = Math.round((expiresAt - now) / 60_000);
  const when = new Date(expiresAt).toISOString();
  if (minutes <= 0) return `${when} (already expired)`;
  return `${when} (in ${minutes} minute${minutes === 1 ? "" : "s"})`;
}

export async function runAuth(argv: readonly string[], overrides: Partial<AuthDeps> = {}): Promise<number> {
  const deps = await resolveDeps(overrides);

  if (argv.includes("--help") || argv.includes("-h")) {
    deps.stdout(AUTH_USAGE);
    return EXIT.OK;
  }
  if (argv.length > 0) {
    deps.stderr(`The auth command takes no options.\n\n${AUTH_USAGE}`);
    return EXIT.USAGE;
  }

  const authEnv = validateAuthEnv(deps.env);
  if (!authEnv.ok) {
    deps.stderr(`${authEnv.message}\n`);
    return EXIT.USAGE;
  }
  try {
    getClioRegion();
  } catch (err) {
    deps.stderr(`${err instanceof Error ? err.message : "Invalid CLIO_REGION."}\n`);
    return EXIT.USAGE;
  }

  let tokens: ClioTokens;
  try {
    tokens = await deps.login();
  } catch (err) {
    deps.stderr(`Login failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
    return EXIT.FATAL;
  }

  let who = "user details unavailable";
  try {
    const me = await deps.whoAmI(tokens.access_token);
    const label = [me.name, me.email ? `<${me.email}>` : ""].filter(Boolean).join(" ");
    who = `${label ? `${label} ` : ""}(user id ${me.id})`;
  } catch {
    if (tokens.clio_user_id) who = `user id ${tokens.clio_user_id}`;
  }

  deps.stdout(`Logged in to Clio as ${who}.\n`);
  deps.stdout(`Token expires: ${describeExpiry(tokens.expires_at, deps.now())}. It refreshes automatically when used.\n`);
  return EXIT.OK;
}
