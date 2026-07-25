import {
  inspectWriterLock,
  repairWriterLock,
} from "@openlapp/lapp";
import {
  parseCommandArgs,
  requiredString,
  UsageError,
} from "../args.js";
import { printJson } from "../output.js";

function noPositionals(positionals: string[]): void {
  if (positionals.length) throw new UsageError("lock commands take no positional arguments");
}

/** Inspect or explicitly repair the current-user global writer lock. */
export async function commandLock(args: string[]): Promise<void> {
  const subcommand = args.shift();
  if (subcommand === "inspect") {
    const { values, positionals } = parseCommandArgs(args, {
      json: { type: "boolean" },
    });
    noPositionals(positionals);
    const inspection = inspectWriterLock();
    if (values.json) {
      printJson({ writerLock: inspection });
    } else if (!inspection.locked) {
      console.log(`unlocked: ${inspection.lockDirectory}`);
    } else {
      console.log(`locked: ${inspection.lockDirectory}`);
      if (inspection.owner) {
        console.log(`token: ${inspection.owner.token}`);
        console.log(`pid: ${inspection.owner.pid}`);
        console.log(`created: ${inspection.owner.createdAt}`);
      } else {
        console.log("owner: invalid");
      }
    }
    return;
  }

  if (subcommand === "repair") {
    const { values, positionals } = parseCommandArgs(args, {
      token: { type: "string" },
      yes: { type: "boolean" },
      json: { type: "boolean" },
    });
    noPositionals(positionals);
    if (!values.yes) {
      throw new UsageError("lock repair is dangerous and requires --yes");
    }
    const token = requiredString(values, "token");
    const owner = repairWriterLock(token);
    if (values.json) printJson({ writerLock: { repaired: true, owner } });
    else console.log(`repaired writer lock owned by ${owner.token}`);
    return;
  }

  throw new UsageError("expected lock inspect or lock repair");
}
