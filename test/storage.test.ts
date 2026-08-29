import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import test, { type TestContext } from "node:test";
import {
  FailureStore,
  isValidPdfFile,
  pdfFilePath,
  prepareOutput,
  savePdfAtomic,
  saveProcessRecord,
  saveRunSummary,
  type OutputPaths
} from "../src/storage.js";
import type {
  DownloadFailure,
  PdfResource,
  ProcessRecord,
  RunSummary
} from "../src/types.js";

test("prepares output directories and deterministic safe PDF paths", async (context) => {
  const output = await temporaryOutput(context);
  const resource: PdfResource = {
    id: "../../resource?id=123",
    kind: "document",
    documentId: "../document/456",
    title: "Decisão: café / ../../outside",
    sourceUrl: "https://example.test/document/456"
  };

  assert.equal((await stat(output.pdfDir)).isDirectory(), true);
  assert.equal((await stat(output.processDir)).isDirectory(), true);

  const first = pdfFilePath(output, "../../process/789", resource);
  const second = pdfFilePath(output, "../../process/789", resource);

  assert.equal(first, second);
  assert.equal(first.startsWith(`${output.pdfDir}${sep}`), true);
  assert.equal(first.endsWith(".pdf"), true);
  assert.equal(basename(first).includes(".."), false);
});

test("saves PDFs atomically, validates signatures, and skips valid existing files", async (context) => {
  const output = await temporaryOutput(context);
  const resource: PdfResource = {
    id: "pdf-1",
    kind: "generated",
    documentId: "doc-1",
    title: "Generated document",
    sourceUrl: "https://example.test/pdf-1"
  };
  const filePath = pdfFilePath(output, "process-1", resource);
  const pdf = Buffer.from("%PDF-1.7\nbody\n%%EOF", "ascii");

  assert.deepEqual(await savePdfAtomic(filePath, pdf), {
    status: "saved",
    bytes: pdf.length
  });
  assert.equal(await isValidPdfFile(filePath), true);
  assert.deepEqual(await readFile(filePath), pdf);

  assert.deepEqual(await savePdfAtomic(filePath, Buffer.from("not a PDF")), {
    status: "skipped",
    bytes: pdf.length
  });
  assert.deepEqual(await readFile(filePath), pdf);

  const names = await readdir(dirname(filePath));
  assert.equal(names.some((name) => name.endsWith(".tmp")), false);
});

test("rejects invalid new PDF content without leaving a file", async (context) => {
  const output = await temporaryOutput(context);
  const filePath = join(output.pdfDir, "invalid.pdf");

  await assert.rejects(
    savePdfAtomic(filePath, Buffer.from("<html>rate limited</html>")),
    /does not have a PDF signature/
  );
  assert.equal(await isValidPdfFile(filePath), false);
});

test("atomically saves process records and the latest run summary", async (context) => {
  const output = await temporaryOutput(context);
  const record = processRecord();
  const summary = runSummary();

  const recordPath = await saveProcessRecord(output, record);
  const summaryPath = await saveRunSummary(output, summary);
  await saveRunSummary(output, { ...summary, processedProcesses: 2 });

  assert.deepEqual(JSON.parse(await readFile(recordPath, "utf8")), record);
  assert.equal(summaryPath, output.runSummaryFile);
  assert.equal(
    (JSON.parse(await readFile(summaryPath, "utf8")) as RunSummary).processedProcesses,
    2
  );
});

test("keeps failures idempotently keyed and serializes concurrent updates", async (context) => {
  const output = await temporaryOutput(context);
  const store = new FailureStore(output.failuresFile);
  const first = downloadFailure("resource-2", "first");
  const second = downloadFailure("resource-1", "second");

  await Promise.all([store.upsert(first), store.upsert(second)]);
  await store.upsert({ ...second, attempts: 4, error: "updated" });

  assert.deepEqual(
    (await store.list()).map(({ id, attempts, error }) => ({ id, attempts, error })),
    [
      { id: "resource-1", attempts: 4, error: "updated" },
      { id: "resource-2", attempts: 3, error: "first" }
    ]
  );
  assert.equal((await store.get("resource-1"))?.attempts, 4);

  const persisted = JSON.parse(await readFile(output.failuresFile, "utf8")) as Record<string, DownloadFailure>;
  assert.deepEqual(Object.keys(persisted), ["resource-1", "resource-2"]);
  assert.equal(await store.remove("resource-1"), true);
  assert.equal(await store.remove("resource-1"), false);
  assert.deepEqual((await store.list()).map(({ id }) => id), ["resource-2"]);

  const unusual = downloadFailure("__proto__", "unusual id");
  await store.upsert(unusual);
  assert.equal((await store.get("__proto__"))?.error, "unusual id");
});

async function temporaryOutput(context: TestContext): Promise<OutputPaths> {
  const directory = await mkdtemp(join(tmpdir(), "scraper-storage-test-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return prepareOutput(directory);
}

function processRecord(): ProcessRecord {
  return {
    processId: "process-id-1",
    processNumber: "0000001-00.2026.4.05.0000",
    scrapedAt: "2026-08-28T12:00:00.000Z",
    query: {},
    summary: {
      className: "Class",
      title: "Title",
      partySummary: "Party",
      lastMovement: "Movement"
    },
    fields: { Court: "TRF5" },
    parties: { active: [], passive: [], others: [] },
    movements: [],
    documents: []
  };
}

function runSummary(): RunSummary {
  return {
    startedAt: "2026-08-28T12:00:00.000Z",
    finishedAt: "2026-08-28T12:01:00.000Z",
    query: {},
    searchResultCount: 1,
    truncated: false,
    processedProcesses: 1,
    discoveredDocuments: 1,
    downloadedPdfs: 1,
    skippedPdfs: 0,
    failedPdfs: 0,
    processErrors: []
  };
}

function downloadFailure(id: string, error: string): DownloadFailure {
  return {
    id,
    processId: "process-id-1",
    processNumber: "0000001-00.2026.4.05.0000",
    documentId: "document-id-1",
    kind: "document",
    title: "Document",
    attempts: 3,
    httpStatus: 429,
    error,
    query: {},
    updatedAt: "2026-08-28T12:00:00.000Z"
  };
}
