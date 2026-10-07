import { wakeCredentials } from "../../src/wake-credentials.ts";
process.exit(await wakeCredentials(process.argv.slice(2)));
