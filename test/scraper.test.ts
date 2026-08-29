import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runScraper } from "../src/scraper.js";
import type { DownloadFailure, ProcessRecord } from "../src/types.js";

const processNumber = "0000001-00.2026.4.05.8000";

test("records an exhausted 429 and continues with the next PDF", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "pje-scraper-test-"));
  let limitedCalls = 0;
  let documentPageCalls = 0;
  let movementPageCalls = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname.endsWith("/ConsultaPublica/listView.seam")) {
      sendHtml(response, searchForm());
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/ConsultaPublica/listView.seam")) {
      sendHtml(response, searchResults());
      return;
    }
    if (url.pathname.endsWith("/DetalheProcessoConsultaPublica/listView.seam")) {
      if (request.method === "POST") {
        const fields = new URLSearchParams(await requestBody(request));
        if (fields.get("AJAXREQUEST") === "detail:documentPanel") {
          documentPageCalls += 1;
          sendHtml(response, documentPage());
          return;
        }
        if (fields.get("AJAXREQUEST") === "detail:movementPanel") {
          movementPageCalls += 1;
          sendHtml(response, movementPage());
          return;
        }
        response.writeHead(400);
        response.end();
        return;
      }
      sendHtml(response, processDetail());
      return;
    }
    if (url.pathname === "/pdf/limited") {
      limitedCalls += 1;
      response.writeHead(429, { "content-type": "text/plain", "retry-after": "0" });
      response.end("limited");
      return;
    }
    if (url.pathname === "/pdf/complete") {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end(Buffer.from("%PDF-1.4\n%%EOF\n", "ascii"));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const summary = await runScraper({
      allowTruncated: false,
      backoffMs: 0,
      baseUrl: `http://127.0.0.1:${address.port}/pjeconsulta/`,
      criteria: { processNumber },
      delayMs: 0,
      maxAttempts: 2,
      maxDownloads: 2,
      maxProcesses: 1,
      outputDir,
      skipPdfs: false,
      timeoutMs: 5_000
    }, () => undefined);

    assert.equal(limitedCalls, 2);
    assert.equal(documentPageCalls, 1);
    assert.equal(movementPageCalls, 1);
    assert.equal(summary.processedProcesses, 1);
    assert.equal(summary.discoveredDocuments, 2);
    assert.equal(summary.failedPdfs, 1);
    assert.equal(summary.downloadedPdfs, 1);

    const failures = JSON.parse(
      await readFile(join(outputDir, "failed-downloads.json"), "utf8")
    ) as Record<string, DownloadFailure>;
    const failure = Object.values(failures)[0];
    assert.equal(failure?.httpStatus, 429);
    assert.equal(failure?.attempts, 2);

    const [recordName] = await readdir(join(outputDir, "processes"));
    assert.ok(recordName);
    const record = JSON.parse(
      await readFile(join(outputDir, "processes", recordName), "utf8")
    ) as ProcessRecord;
    assert.equal(record.movements.length, 2);
    assert.deepEqual(
      record.documents.flatMap((document) => document.pdfs.map((pdf) => pdf.status)),
      ["failed", "downloaded"]
    );
    const downloaded = record.documents[1]?.pdfs[0];
    assert.ok(downloaded?.file);
    assert.equal(
      (await readFile(join(outputDir, downloaded.file))).subarray(0, 5).toString("ascii"),
      "%PDF-"
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(outputDir, { recursive: true, force: true });
  }
});

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

async function requestBody(request: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function searchForm(): string {
  return `
    <form id="fPP" action="/pjeconsulta/ConsultaPublica/listView.seam">
      <input name="fPP" value="fPP">
      <input name="fPP:numProcesso-inputNumeroProcesso" value="">
      <input name="fPP:dataAutuacaoInicioInputDate" value="">
      <input name="fPP:dataAutuacaoFimInputDate" value="">
      <input name="javax.faces.ViewState" value="state-1">
    </form>
    <script>function executarReCaptcha(){if(false){grecaptcha.execute();}}</script>
    <script id="fPP:search">executarPesquisa=function(){}</script>
  `;
}

function searchResults(): string {
  const detail = "/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=sanitized";
  return `
    <table id="fPP:processosTable"><tbody><tr class="rich-table-row">
      <td id="fPP:processosTable:42:open"><a onclick="openPopUp('Consulta','${detail}')">Abrir</a></td>
      <td>CLASSE <a onclick="openPopUp('Consulta','${detail}')">${processNumber} - Assunto</a> PARTE A X PARTE B</td>
      <td>Movimento recente</td>
    </tr></tbody></table>
    <span>1 resultado encontrado</span>
  `;
}

function processDetail(): string {
  return `
    <form id="detail:fields">
      <div class="propertyView"><div class="name">Número Processo</div><div class="value">${processNumber}</div></div>
    </form>
    <table id="detail:processoPartesPoloAtivoResumidoList"><tbody></tbody></table>
    <table id="detail:processoPartesPoloPassivoResumidoList"><tbody></tbody></table>
    <table id="detail:processoParteOutrosInteressadosResumidoList"><tbody></tbody></table>
    <div class="rich-panel-body">
      <table id="detail:processoEvento"><tbody><tr class="rich-table-row"><td>01/08/2026 10:00:00 - Movimento</td></tr></tbody></table>
      ${pager("movement", 1)}
    </div>
    <div class="rich-panel-body">
      <table id="detail:processoDocumentoGridTab"><tbody>
        <tr class="rich-table-row"><td><a href="/pdf/limited?idBin=11&amp;idProcessoDocumento=101">01/08/2026 10:00:00 - Primeiro (Documento)</a></td></tr>
      </tbody></table>
      ${pager("document", 1)}
    </div>
  `;
}

function documentPage(): string {
  return `
    <div class="rich-panel-body">
      <table id="detail:processoDocumentoGridTab"><tbody>
        <tr class="rich-table-row"><td><a href="/pdf/complete?idBin=12&amp;idProcessoDocumento=102">01/08/2026 10:01:00 - Segundo (Documento)</a></td></tr>
      </tbody></table>
      ${pager("document", 2)}
    </div>
  `;
}

function movementPage(): string {
  return `
    <div class="rich-panel-body">
      <table id="detail:processoEvento"><tbody><tr class="rich-table-row"><td>01/08/2026 11:00:00 - Segundo movimento</td></tr></tbody></table>
      ${pager("movement", 2)}
    </div>
  `;
}

function pager(kind: "document" | "movement", page: number): string {
  const formId = `detail:${kind}Form`;
  const sliderId = `detail:${kind}Slider`;
  const eventId = `detail:${kind}Event`;
  const panelId = `detail:${kind}Panel`;
  return `
    <form id="${formId}" action="/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam">
      <input class="rich-inslider-field" id="${sliderId}Input" name="${sliderId}" value="${page}">
      <input name="javax.faces.ViewState" value="state-${kind}-${page}">
    </form>
    <script>new Richfaces.Slider("${sliderId}",{'maxValue':'2','sliderValue':'${page}','onchange':'A4J.AJAX.Submit('${formId}',event,{'similarityGroupingId':'${eventId}','actionUrl':'/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam','containerId':'${panelId}'})'})</script>
  `;
}
