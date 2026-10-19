import { runAuth } from "./auth.js";
import { runExport } from "./export.js";
import { EXIT } from "./args.js";
import { USAGE } from "./usage.js";

export async function runCli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  process.env.TRANSPORT = "stdio";

  if (command === "auth") return runAuth(rest);
  if (command === "export") return runExport(rest);

  process.stderr.write(`Unknown command.\n\n${USAGE}`);
  return EXIT.USAGE;
}
