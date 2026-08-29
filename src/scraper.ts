import { Buffer } from "node:buffer";
import path from "node:path";
import {
  buildPagerFields,
  buildSearchFields,
  parseDetailPage,
  parseDocumentRows,
  parseHtmlPdfForm,
  parseMovementRows,
  parsePager,
  parseSearchForm,
  parseSearchResponse
} from "./parsers.js";
import { PjeClient, type PjeHeaders, type PjeResponse } from "./pje-client.js";
import { RetryExhaustedError, withRetry } from "./retry.js";
import {
  FailureStore,
  isValidPdfFile,
  pdfFilePath,
  prepareOutput,
  savePdfAtomic,
  saveProcessRecord,
  saveRunSummary,
  type OutputPaths
} from "./storage.js";
import type {
  DetailPage,
  DocumentDiscovery,
  DownloadFailure,
  MovementRecord,
  PdfRecord,
  PdfResource,
  ProcessRecord,
  RunSummary,
  SearchCriteria,
  SearchResult
} from "./types.js";

export interface ScraperOptions {
  allowTruncated: boolean;
  backoffMs: number;
  baseUrl: string;
  criteria: SearchCriteria;
  delayMs: number;
  maxAttempts: number;
  maxDownloads: number;
  maxProcesses: number;
  outputDir: string;
  skipPdfs: boolean;
  timeoutMs: number;
}

type Logger = (message: string) => void;

interface DownloadCounters {
  attempted: number;
  downloaded: number;
  failed: number;
  skipped: number;
}

interface ProcessExtraction {
  detail: DetailPage;
  documents: DocumentDiscovery[];
  movements: MovementRecord[];
}

const SEARCH_PATH = "ConsultaPublica/listView.seam";

export async function runScraper(
  options: ScraperOptions,
  log: Logger = console.log
): Promise<RunSummary> {
  const startedAt = new Date().toISOString();
  const output = await prepareOutput(options.outputDir);
  const failures = new FailureStore(output.failuresFile);
  const client = new PjeClient({
    baseUrl: options.baseUrl,
    delayMs: options.delayMs,
    timeoutMs: options.timeoutMs
  });
  const searchUrl = client.resolveUrl(SEARCH_PATH);
  const counters: DownloadCounters = {
    attempted: 0,
    downloaded: 0,
    failed: 0,
    skipped: 0
  };

  log("Iniciando sesión pública del PJe");
  const initial = await client.getText(searchUrl);
  assertSuccessfulPage(initial, "No fue posible cargar el formulario de consulta");
  const form = parseSearchForm(initial.body, initial.finalUrl);
  if (form.captchaEnabled) {
    throw new Error("El portal activó reCAPTCHA; el scraper no intenta eludirlo");
  }

  const searchFields = buildSearchFields(form, options.criteria);
  log(`Ejecutando búsqueda ${describeCriteria(options.criteria)}`);
  const searchPage = await client.postFormText(form.actionUrl, searchFields, initial.finalUrl);
  assertSuccessfulPage(searchPage, "La búsqueda pública falló");
  const search = parseSearchResponse(searchPage.body, searchPage.finalUrl);
  const summary: RunSummary = {
    startedAt,
    finishedAt: startedAt,
    query: options.criteria,
    searchResultCount: search.resultCount,
    truncated: search.truncated,
    processedProcesses: 0,
    discoveredDocuments: 0,
    downloadedPdfs: 0,
    skippedPdfs: 0,
    failedPdfs: 0,
    processErrors: []
  };

  for (const message of search.messages) {
    log(`Portal: ${message}`);
  }

  if (search.truncated && !options.allowTruncated) {
    summary.finishedAt = new Date().toISOString();
    await saveRunSummary(output, summary);
    throw new Error("La consulta fue truncada por el límite de 30 procesos; refine los criterios o use --allow-truncated");
  }
  if (search.results.length === 0) {
    summary.finishedAt = new Date().toISOString();
    await saveRunSummary(output, summary);
    const reason = search.messages[0] ?? "La consulta no devolvió procesos";
    throw new Error(reason);
  }

  const selected = search.results.slice(0, options.maxProcesses);
  for (const result of selected) {
    try {
      log(`Extrayendo proceso ${result.processNumber}`);
      const extraction = await extractProcess(client, result, searchUrl, log);
      const documents = await downloadDocuments({
        client,
        counters,
        discoveries: extraction.documents,
        failures,
        log,
        options,
        output,
        result
      });
      const record: ProcessRecord = {
        processId: result.processId,
        processNumber: result.processNumber,
        scrapedAt: new Date().toISOString(),
        query: options.criteria,
        summary: {
          className: result.className,
          title: result.title,
          partySummary: result.partySummary,
          lastMovement: result.lastMovement
        },
        fields: extraction.detail.fields,
        parties: extraction.detail.parties,
        movements: extraction.movements,
        documents
      };
      await saveProcessRecord(output, record);
      summary.processedProcesses += 1;
      summary.discoveredDocuments += documents.length;
      log(`Proceso ${result.processNumber}: ${documents.length} documentos, ${extraction.movements.length} movimientos`);
    } catch (error) {
      const message = safeErrorMessage(error);
      summary.processErrors.push({
        processId: result.processId,
        processNumber: result.processNumber,
        error: message
      });
      log(`Proceso ${result.processNumber}: error registrado y se continúa`);
    }
  }

  summary.downloadedPdfs = counters.downloaded;
  summary.skippedPdfs = counters.skipped;
  summary.failedPdfs = counters.failed;
  summary.finishedAt = new Date().toISOString();
  await saveRunSummary(output, summary);
  return summary;
}

async function extractProcess(
  client: PjeClient,
  result: SearchResult,
  referer: string,
  log: Logger
): Promise<ProcessExtraction> {
  const response = await client.getText(result.detailUrl, referer);
  assertSuccessfulPage(response, "El detalle del proceso no está disponible");
  const detail = parseDetailPage(response.body, response.finalUrl);
  if (Object.keys(detail.fields).length === 0) {
    throw new Error("El detalle no contiene los campos esperados del proceso");
  }

  const documents = [...detail.documents];
  if (detail.documentPager && detail.documentPager.maxPage > 1) {
    let pager = detail.documentPager;
    for (let page = pager.page + 1; page <= pager.maxPage; page += 1) {
      log(`Proceso ${result.processNumber}: página de documentos ${page}/${pager.maxPage}`);
      const pageResponse = await client.postFormText(
        pager.actionUrl,
        buildPagerFields(pager, page),
        response.finalUrl
      );
      assertSuccessfulPage(pageResponse, "Falló la paginación de documentos");
      const nextPager = parsePager(
        pageResponse.body,
        pageResponse.finalUrl,
        "processoDocumentoGridTab"
      );
      if (!nextPager || nextPager.page !== page || nextPager.maxPage !== pager.maxPage) {
        throw new Error(`El portal no confirmó la página ${page} de documentos`);
      }
      const pageDocuments = parseDocumentRows(pageResponse.body, pageResponse.finalUrl);
      const knownDocumentIds = new Set(documents.map(({ document }) => document.documentId));
      if (pageDocuments.length === 0
        || pageDocuments.every(({ document }) => knownDocumentIds.has(document.documentId))) {
        throw new Error(`La página ${page} de documentos no aportó registros nuevos`);
      }
      documents.push(...pageDocuments);
      pager = nextPager;
    }
  }

  let movements = [...detail.movements];
  let movementPager = detail.movementPager;
  if (movementPager && movementPager.maxPage > 1) {
    if (detail.documentPager && detail.documentPager.maxPage > 1) {
      const reset = await client.getText(result.detailUrl, referer);
      assertSuccessfulPage(reset, "No fue posible restablecer el detalle para paginar movimientos");
      movements = parseMovementRows(reset.body);
      movementPager = parsePager(reset.body, reset.finalUrl, "processoEvento");
      if (!movementPager) {
        throw new Error("El portal dejó de informar el paginador de movimientos");
      }
    }

    let pager = movementPager;
    for (let page = pager.page + 1; page <= pager.maxPage; page += 1) {
      log(`Proceso ${result.processNumber}: página de movimientos ${page}/${pager.maxPage}`);
      const pageResponse = await client.postFormText(
        pager.actionUrl,
        buildPagerFields(pager, page),
        result.detailUrl
      );
      assertSuccessfulPage(pageResponse, "Falló la paginación de movimientos");
      const nextPager = parsePager(pageResponse.body, pageResponse.finalUrl, "processoEvento");
      if (!nextPager || nextPager.page !== page || nextPager.maxPage !== pager.maxPage) {
        throw new Error(`El portal no confirmó la página ${page} de movimientos`);
      }
      const pageMovements = parseMovementRows(pageResponse.body);
      const knownMovements = new Set(movements.map((movement) => JSON.stringify(movement.cells)));
      if (pageMovements.length === 0
        || pageMovements.every((movement) => knownMovements.has(JSON.stringify(movement.cells)))) {
        throw new Error(`La página ${page} de movimientos no aportó registros nuevos`);
      }
      movements.push(...pageMovements);
      pager = nextPager;
    }
  }

  return {
    detail,
    documents: uniqueDocuments(documents),
    movements: uniqueMovements(movements)
  };
}

interface DownloadDocumentsContext {
  client: PjeClient;
  counters: DownloadCounters;
  discoveries: DocumentDiscovery[];
  failures: FailureStore;
  log: Logger;
  options: ScraperOptions;
  output: OutputPaths;
  result: SearchResult;
}

async function downloadDocuments(context: DownloadDocumentsContext): Promise<ProcessRecord["documents"]> {
  const records: ProcessRecord["documents"] = [];

  for (const discovery of context.discoveries) {
    const pdfs: PdfRecord[] = [];
    for (const resource of discovery.resources) {
      const target = pdfFilePath(context.output, context.result.processNumber, resource);
      const relativeFile = portableRelative(context.output.rootDir, target);
      const failureId = `${context.result.processId}:${resource.id}`;

      if (await isValidPdfFile(target)) {
        await context.failures.remove(failureId);
        pdfs.push({
          id: resource.id,
          kind: resource.kind,
          title: resource.title,
          status: "skipped",
          attempts: 0,
          file: relativeFile
        });
        context.counters.skipped += 1;
        continue;
      }

      if (context.options.skipPdfs || context.counters.attempted >= context.options.maxDownloads) {
        pdfs.push({
          id: resource.id,
          kind: resource.kind,
          title: resource.title,
          status: "skipped",
          attempts: 0
        });
        context.counters.skipped += 1;
        continue;
      }

      context.counters.attempted += 1;
      try {
        const downloaded = await withRetry(
          async (attempt) => {
            if (attempt > 1) {
              context.log(`Documento ${resource.documentId}: reintento ${attempt}/${context.options.maxAttempts}`);
            }
            return fetchPdf(context.client, resource, context.result.detailUrl);
          },
          {
            maxAttempts: context.options.maxAttempts,
            baseDelayMs: context.options.backoffMs,
            maxDelayMs: Math.max(60_000, context.options.backoffMs)
          }
        );
        const saved = await savePdfAtomic(target, downloaded.body);
        await context.failures.remove(failureId);
        pdfs.push({
          id: resource.id,
          kind: resource.kind,
          title: resource.title,
          status: saved.status === "saved" ? "downloaded" : "skipped",
          attempts: downloaded.attempts,
          file: relativeFile,
          bytes: saved.bytes
        });
        if (saved.status === "saved") {
          context.counters.downloaded += 1;
        } else {
          context.counters.skipped += 1;
        }
      } catch (error) {
        const attempts = error instanceof RetryExhaustedError ? error.attempts : 1;
        const status = error instanceof RetryExhaustedError ? error.status : undefined;
        const message = safeErrorMessage(error);
        const failure: DownloadFailure = {
          id: failureId,
          processId: context.result.processId,
          processNumber: context.result.processNumber,
          documentId: resource.documentId,
          kind: resource.kind,
          title: resource.title,
          attempts,
          error: message,
          query: context.options.criteria,
          updatedAt: new Date().toISOString(),
          ...(status === undefined ? {} : { httpStatus: status })
        };
        await context.failures.upsert(failure);
        pdfs.push({
          id: resource.id,
          kind: resource.kind,
          title: resource.title,
          status: "failed",
          attempts,
          error: message
        });
        context.counters.failed += 1;
        context.log(`Documento ${resource.documentId}: descarga fallida registrada`);
      }
    }

    records.push({
      ...discovery.document,
      pdfs
    });
  }

  return records;
}

async function fetchPdf(
  client: PjeClient,
  resource: PdfResource,
  referer: string
): Promise<PjeResponse<Buffer>> {
  let response: PjeResponse<Buffer>;
  if (resource.kind === "generated") {
    const documentPage = await client.getText(resource.sourceUrl, referer);
    if (documentPage.status < 200 || documentPage.status >= 300) {
      return {
        ...documentPage,
        body: Buffer.from(documentPage.body, "utf8")
      };
    }
    try {
      const form = parseHtmlPdfForm(documentPage.body, documentPage.finalUrl);
      response = await client.postFormBinary(
        form.actionUrl,
        new URLSearchParams(form.fields),
        documentPage.finalUrl
      );
    } catch {
      return {
        status: 503,
        headers: documentPage.headers,
        body: Buffer.from(documentPage.body, "utf8"),
        finalUrl: documentPage.finalUrl
      };
    }
  } else {
    response = await client.getBinary(resource.sourceUrl, referer);
  }

  if (response.status >= 200 && response.status < 300 && !isPdfResponse(response)) {
    return {
      ...response,
      status: 502
    };
  }
  return response;
}

function isPdfResponse(response: PjeResponse<Buffer>): boolean {
  const contentType = headerValue(response.headers, "content-type");
  return /application\/pdf/i.test(contentType) && response.body.subarray(0, 5).equals(Buffer.from("%PDF-"));
}

function headerValue(headers: PjeHeaders, name: string): string {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value ?? "";
}

function assertSuccessfulPage(response: PjeResponse<string>, message: string): void {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${message} (HTTP ${response.status})`);
  }
  if (/\/(?:login|errorUnexpected)\.seam(?:\?|$)/i.test(response.finalUrl)) {
    throw new Error(message);
  }
  if (/erro inesperado|unexpected error|javax\.servlet\.ServletException/i.test(response.body)) {
    throw new Error(message);
  }
}

function uniqueDocuments(documents: DocumentDiscovery[]): DocumentDiscovery[] {
  const unique = new Map<string, DocumentDiscovery>();
  for (const discovery of documents) {
    const current = unique.get(discovery.document.documentId);
    if (!current) {
      unique.set(discovery.document.documentId, discovery);
      continue;
    }
    const resources = new Map(current.resources.map((resource) => [resource.id, resource]));
    for (const resource of discovery.resources) {
      resources.set(resource.id, resource);
    }
    current.resources = [...resources.values()];
  }
  return [...unique.values()];
}

function uniqueMovements(movements: MovementRecord[]): MovementRecord[] {
  const unique = new Map<string, MovementRecord>();
  for (const movement of movements) {
    unique.set(JSON.stringify(movement.cells), movement);
  }
  return [...unique.values()];
}

function describeCriteria(criteria: SearchCriteria): string {
  if (criteria.processNumber) {
    return `por proceso ${criteria.processNumber}`;
  }
  return `entre ${criteria.from ?? "?"} y ${criteria.to ?? "?"}`;
}

function portableRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(ca|cid|jsessionid)=[^&\s"']+/gi, "$1=[redacted]")
    .replace(/;jsessionid=[^?\s"']+/gi, ";jsessionid=[redacted]")
    .slice(0, 500);
}
