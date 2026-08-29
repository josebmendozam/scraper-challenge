import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScraper } from "./scraper.js";
import type { ProcessRecord } from "./types.js";

const processNumber = process.env.PJE_SMOKE_PROCESS ?? "0006388-48.1986.4.05.8401";
const outputDir = await mkdtemp(join(tmpdir(), "trf5-pje-smoke-"));
let traversedDocumentPages = false;

try {
  const summary = await runScraper({
    allowTruncated: false,
    backoffMs: 2_000,
    baseUrl: "https://pjett.trf5.jus.br/pjeconsulta/",
    criteria: { processNumber },
    delayMs: 1_500,
    maxAttempts: 3,
    maxDownloads: 1,
    maxProcesses: 1,
    outputDir,
    skipPdfs: false,
    timeoutMs: 30_000
  }, (message) => {
    console.log(message);
    traversedDocumentPages ||= /página de documentos 2\/\d+/.test(message);
  });

  if (summary.truncated
    || summary.searchResultCount !== 1
    || summary.processedProcesses !== 1
    || summary.processErrors.length > 0
    || summary.discoveredDocuments < 30
    || summary.downloadedPdfs !== 1
    || summary.failedPdfs > 0
    || !traversedDocumentPages) {
    throw new Error(`Resultado live inesperado: ${JSON.stringify(summary)}`);
  }

  const [recordName] = await readdir(join(outputDir, "processes"));
  if (!recordName) {
    throw new Error("La prueba live no guardó el proceso");
  }
  const record = JSON.parse(
    await readFile(join(outputDir, "processes", recordName), "utf8")
  ) as ProcessRecord;
  const downloaded = record.documents
    .flatMap((document) => document.pdfs)
    .find((pdf) => pdf.status === "downloaded");
  if (record.documents.length !== summary.discoveredDocuments
    || record.movements.length === 0
    || !downloaded?.file) {
    throw new Error("La prueba live no extrajo movimientos y un PDF");
  }
  const signature = (await readFile(join(outputDir, downloaded.file))).subarray(0, 5).toString("ascii");
  if (signature !== "%PDF-") {
    throw new Error("La prueba live recibió un archivo que no es PDF");
  }

  console.log(
    `Smoke live correcto: ${record.documents.length} documentos, ${record.movements.length} movimientos y 1 PDF`
  );
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
