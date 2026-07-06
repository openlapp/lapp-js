import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// lapp-js/scripts -> sibling lapp repo
export const lappRoot = path.resolve(here, "..", "..", "lapp");
export const lappExamples = path.join(lappRoot, "examples");
export const lappFixtures = path.join(lappRoot, "tools", "validator", "fixtures");
export const lappSchema = path.join(lappRoot, "schema");
