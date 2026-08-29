import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
  DownloadFailure,
  PdfResource,
  ProcessRecord,
  RunSummary
} from "./types.js";

export interface OutputPaths {
  rootDir: string;
  pdfDir: string;
  processDir: string;
  failuresFile: string;
  runSummaryFile: string;
}

export interface PdfSaveResult {
  status: "saved" | "skipped";
  bytes: number;
}

const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");
const WINDOWS_RESERVED_NAME = /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\.|$)/i;

export async function prepareOutput(outputDir: string): Promise<OutputPaths> {
  const rootDir = resolve(outputDir);
  const pdfDir = join(rootDir, "pdfs");
  const processDir = join(rootDir, "processes");

  await Promise.all([
    mkdir(pdfDir, { recursive: true }),
    mkdir(processDir, { recursive: true })
  ]);

  return {
    rootDir,
    pdfDir,
    processDir,
    failuresFile: join(rootDir, "failed-downloads.json"),
    runSummaryFile: join(rootDir, "run-summary.json")
  };
}

export function pdfFilePath(
  output: OutputPaths,
  processNumber: string,
  resource: PdfResource
): string {
  const processDirectory = `${safeSegment(processNumber, "process", 80)}-${shortHash(processNumber)}`;
  const document = safeSegment(resource.documentId, "document", 64);
  const title = safeSegment(resource.title, "pdf", 80);
  const fileName = `${document}--${resource.kind}--${title}--${shortHash(resource.id)}.pdf`;
  const target = resolve(output.pdfDir, processDirectory, fileName);
  assertInside(output.pdfDir, target);
  return target;
}

export async function isValidPdfFile(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const signature = Buffer.alloc(PDF_SIGNATURE.length);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    return bytesRead === PDF_SIGNATURE.length && signature.equals(PDF_SIGNATURE);
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function savePdfAtomic(filePath: string, data: Buffer): Promise<PdfSaveResult> {
  if (await isValidPdfFile(filePath)) {
    const existing = await stat(filePath);
    return { status: "skipped", bytes: existing.size };
  }

  if (!hasPdfSignature(data)) {
    throw new TypeError("Downloaded content does not have a PDF signature");
  }

  await writeFileAtomic(filePath, data);
  return { status: "saved", bytes: data.byteLength };
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value, undefined, 2);
  if (json === undefined) {
    throw new TypeError("Value cannot be represented as JSON");
  }
  await writeFileAtomic(filePath, Buffer.from(`${json}\n`, "utf8"));
}

export async function saveProcessRecord(
  output: OutputPaths,
  record: ProcessRecord
): Promise<string> {
  const fileName = `${safeSegment(record.processNumber, "process", 96)}-${shortHash(record.processId)}.json`;
  const target = resolve(output.processDir, fileName);
  assertInside(output.processDir, target);
  await writeJsonAtomic(target, record);
  return target;
}

export async function saveRunSummary(output: OutputPaths, summary: RunSummary): Promise<string> {
  await writeJsonAtomic(output.runSummaryFile, summary);
  return output.runSummaryFile;
}

export class FailureStore {
  readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async get(id: string): Promise<DownloadFailure | undefined> {
    return this.enqueue(async () => {
      const failures = await readFailures(this.filePath);
      return failures[id];
    });
  }

  async list(): Promise<DownloadFailure[]> {
    return this.enqueue(async () => {
      const failures = await readFailures(this.filePath);
      return Object.keys(failures)
        .sort(compareIds)
        .map((id) => failures[id] as DownloadFailure);
    });
  }

  async upsert(failure: DownloadFailure): Promise<void> {
    if (failure.id.trim().length === 0) {
      throw new TypeError("Failure id cannot be empty");
    }

    await this.enqueue(async () => {
      const failures = await readFailures(this.filePath);
      failures[failure.id] = failure;
      await writeJsonAtomic(this.filePath, sortedFailureMap(failures));
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const failures = await readFailures(this.filePath);
      if (!(id in failures)) {
        return false;
      }

      delete failures[id];
      await writeJsonAtomic(this.filePath, sortedFailureMap(failures));
      return true;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function hasPdfSignature(data: Buffer): boolean {
  return data.length >= PDF_SIGNATURE.length
    && data.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE);
}

async function writeFileAtomic(filePath: string, data: Buffer): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    await writeFile(temporary, data, { flag: "wx" });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readFailures(filePath: string): Promise<Record<string, DownloadFailure>> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return emptyFailureMap();
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new SyntaxError(`Invalid failure store JSON at ${filePath}`, { cause: error });
  }

  if (!isRecord(value)) {
    throw new TypeError(`Failure store at ${filePath} must contain an object`);
  }

  const failures = emptyFailureMap();
  for (const [id, failure] of Object.entries(value)) {
    if (!isDownloadFailure(failure) || failure.id !== id) {
      throw new TypeError(`Failure store entry ${id} is invalid`);
    }
    failures[id] = failure;
  }
  return failures;
}

function sortedFailureMap(
  failures: Record<string, DownloadFailure>
): Record<string, DownloadFailure> {
  const sorted = emptyFailureMap();
  for (const [id, failure] of Object.entries(failures).sort(([left], [right]) => compareIds(left, right))) {
    sorted[id] = failure;
  }
  return sorted;
}

function emptyFailureMap(): Record<string, DownloadFailure> {
  return Object.create(null) as Record<string, DownloadFailure>;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isDownloadFailure(value: unknown): value is DownloadFailure {
  if (!isRecord(value) || !isRecord(value.query)) {
    return false;
  }

  const queryValuesAreStrings = Object.values(value.query).every(
    (field) => field === undefined || typeof field === "string"
  );

  return typeof value.id === "string"
    && typeof value.processId === "string"
    && typeof value.processNumber === "string"
    && typeof value.documentId === "string"
    && (value.kind === "document" || value.kind === "generated")
    && typeof value.title === "string"
    && Number.isInteger(value.attempts)
    && (value.httpStatus === undefined || Number.isInteger(value.httpStatus))
    && typeof value.error === "string"
    && typeof value.updatedAt === "string"
    && queryValuesAreStrings;
}

function safeSegment(value: string, fallback: string, maxLength: number): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, maxLength)
    .replace(/[. ]+$/g, "");
  const segment = normalized.length === 0 ? fallback : normalized;
  return WINDOWS_RESERVED_NAME.test(segment) ? `_${segment}` : segment;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function assertInside(parent: string, child: string): void {
  const resolvedParent = resolve(parent);
  if (child !== resolvedParent && !child.startsWith(`${resolvedParent}${sep}`)) {
    throw new Error(`Generated path escapes ${resolvedParent}`);
  }
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
