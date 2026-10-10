// Entry for the build that records the bytecode-order profile: the server must exit normally on SIGTERM, because the
// runtime writes the profile only on a normal exit. Never shipped; scripts/train-bytecode-order.ts builds and runs it.
import { main } from "../src/cli.ts";

process.on("SIGTERM", () => process.exit(0));
void main();
