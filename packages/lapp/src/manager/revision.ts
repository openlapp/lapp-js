import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REVISION_DOMAIN = Buffer.from("lapp-profile-revision-v1\0", "ascii");
const REGISTRY_REVISION_DOMAIN = Buffer.from("lapp-profile-revision-v2\0", "ascii");

type RecordState = 0 | 1 | 2 | 3;

interface RevisionRecord {
  relativePath: string;
  pathBytes: Buffer;
  state: RecordState;
  content?: Buffer;
}

export class ProfilePathInvalidError extends Error {
  override name = "ProfilePathInvalidError";
  readonly code = "PROFILE_PATH_INVALID" as const;

  constructor(message = "a managed profile directory name is not valid UTF-8") {
    super(message);
  }
}

function uint32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function uint64(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function inspectRecord(root: string, relativePath: string): RevisionRecord {
  const target = path.join(root, ...relativePath.split("/"));
  const pathBytes = Buffer.from(relativePath, "utf8");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { relativePath, pathBytes, state: 0 };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) return { relativePath, pathBytes, state: 3 };
  if (stat.isFile()) {
    return { relativePath, pathBytes, state: 1, content: fs.readFileSync(target) };
  }
  if (stat.isDirectory()) return { relativePath, pathBytes, state: 2 };
  return { relativePath, pathBytes, state: 3 };
}

/**
 * Hash the exact managed profile bytes using the language-neutral LAPP v1
 * framing. The returned revision is opaque except for equality comparison.
 */
function directoryRecords(
  root: string,
  directoryName: "providers" | "auth",
  definitionFile: "provider.json" | "auth.json",
): RevisionRecord[] {
  const records: RevisionRecord[] = [inspectRecord(root, directoryName)];
  if (records[0]!.state !== 2) return records;
  const directory = path.join(root, directoryName);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const names = fs.readdirSync(directory, { encoding: "buffer" }) as Buffer[];
  for (const nameBytes of names) {
    let name: string;
    try {
      name = decoder.decode(nameBytes);
    } catch {
      throw new ProfilePathInvalidError();
    }
    const entryPath = `${directoryName}/${name}`;
    const entryRecord = inspectRecord(root, entryPath);
    if (entryRecord.state !== 2) continue;
    records.push(entryRecord);
    records.push(inspectRecord(root, `${entryPath}/${definitionFile}`));
    records.push(inspectRecord(root, `${entryPath}/models.json`));
  }
  return records;
}

function computeRevision(
  rootDir: string,
  domain: Buffer,
  includeAuth: boolean,
): string {
  const root = path.resolve(rootDir);
  const records: RevisionRecord[] = [
    inspectRecord(root, "global.json"),
    ...directoryRecords(root, "providers", "provider.json"),
  ];
  if (includeAuth) records.push(...directoryRecords(root, "auth", "auth.json"));
  records.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));

  const hash = createHash("sha256");
  hash.update(domain);
  hash.update(uint32(records.length));
  for (const record of records) {
    hash.update(uint32(record.pathBytes.length));
    hash.update(record.pathBytes);
    hash.update(Buffer.from([record.state]));
    if (record.state === 1) {
      const content = record.content!;
      hash.update(uint64(content.length));
      hash.update(content);
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

export function computeProfileRevision(rootDir: string): string {
  return computeRevision(rootDir, REVISION_DOMAIN, false);
}

/** Hash the complete Provider + Auth registry using the LAPP revision-v2 framing. */
export function computeRegistryRevision(rootDir: string): string {
  return computeRevision(rootDir, REGISTRY_REVISION_DOMAIN, true);
}
