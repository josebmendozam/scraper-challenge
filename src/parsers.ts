import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type {
  DetailPage,
  DocumentDiscovery,
  HtmlPdfForm,
  MovementRecord,
  PagerState,
  ParticipantRecord,
  SearchCriteria,
  SearchFormState,
  SearchResponse,
  SearchResult
} from "./types.js";

type Selection = ReturnType<CheerioAPI>;

export function parseSearchForm(html: string, pageUrl: string): SearchFormState {
  const $ = cheerio.load(html);
  const form = $("form#fPP").first();
  if (form.length === 0) {
    throw new Error("No se encontró el formulario público fPP");
  }

  const searchScript = $("script")
    .filter((_, element) => $(element).text().includes("executarPesquisa=function"))
    .first();
  const searchSource = searchScript.attr("id") ?? extractSearchSource(searchScript.text());
  if (!searchSource) {
    throw new Error("No se encontró la acción JSF de búsqueda");
  }

  // The portal renders reCAPTCHA code even when disabled behind if(false), so script presence alone is not activation.
  const captchaScript = $("script")
    .map((_, element) => $(element).text())
    .get()
    .find((text) => text.includes("executarReCaptcha"));
  const captchaEnabled = captchaScript !== undefined
    && /grecaptcha\.execute\s*\(/.test(captchaScript)
    && !/if\s*\(\s*false\s*\)/.test(captchaScript);
  const fields = collectFormFields($, form);
  const viewState = fields["javax.faces.ViewState"];
  if (!viewState) {
    throw new Error("No se encontró javax.faces.ViewState en la búsqueda");
  }

  return {
    actionUrl: resolveCleanUrl(form.attr("action") ?? pageUrl, pageUrl),
    fields,
    searchSource,
    viewState,
    captchaEnabled
  };
}

export function buildSearchFields(
  form: SearchFormState,
  criteria: SearchCriteria
): URLSearchParams {
  const fields = { ...form.fields };
  setBySuffix(
    fields,
    "numProcesso-inputNumeroProcesso",
    criteria.processNumber ?? ""
  );
  setBySuffix(fields, "dataAutuacaoInicioInputDate", criteria.from ?? "");
  setBySuffix(fields, "dataAutuacaoFimInputDate", criteria.to ?? "");
  if (criteria.from) {
    setBySuffix(fields, "dataAutuacaoInicioInputCurrentDate", monthYear(criteria.from));
  }
  if (criteria.to) {
    setBySuffix(fields, "dataAutuacaoFimInputCurrentDate", monthYear(criteria.to));
  }

  const parameters = new URLSearchParams();
  parameters.set("AJAXREQUEST", "_viewRoot");
  for (const [name, value] of Object.entries(fields)) {
    parameters.set(name, value);
  }
  parameters.set("fPP", fields.fPP ?? "fPP");
  parameters.set("javax.faces.ViewState", form.viewState);
  parameters.set(form.searchSource, form.searchSource);
  parameters.set("AJAX:EVENTS_COUNT", "1");
  return parameters;
}

export function parseSearchResponse(html: string, pageUrl: string): SearchResponse {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  const table = tableBySuffix($, "processosTable");

  table.find("tbody > tr.rich-table-row").each((_, row) => {
    const cells = $(row).children("td");
    if (cells.length < 3) {
      return;
    }
    const detailControl = cells.eq(0).find("[onclick*='DetalheProcessoConsultaPublica']").first();
    const detailUrl = extractPopupUrl(
      detailControl.attr("onclick") ?? "",
      "DetalheProcessoConsultaPublica/listView.seam"
    );
    if (!detailUrl) {
      return;
    }

    const processCell = cells.eq(1);
    const processLink = processCell.find("[onclick*='DetalheProcessoConsultaPublica']").first();
    const title = cleanText($, processLink);
    const allText = cleanText($, processCell);
    const className = normalizeText(processCell.contents().first().text());
    const processNumber = (title.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/)
      ?? allText.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/))?.[0];
    if (!processNumber) {
      return;
    }
    const partySummary = removeLeading(removeLeading(allText, className), title);
    const cellId = cells.eq(0).attr("id") ?? "";
    const processId = /processosTable:([^:]+):/.exec(cellId)?.[1]
      ?? stableId(`${processNumber}:${detailUrl}`);

    results.push({
      processId,
      processNumber,
      className,
      title,
      partySummary,
      lastMovement: cleanText($, cells.eq(2)),
      detailUrl: resolveCleanUrl(detailUrl, pageUrl)
    });
  });

  const messages = uniqueStrings([
    ...$(".alert-danger, .alert-warning, .rich-message-label")
      .map((_, element) => cleanText($, $(element)))
      .get(),
    ...$("dl.rich-messages")
      .map((_, element) => cleanText($, $(element)))
      .get()
  ]).filter(Boolean);
  const pageText = normalizeText($.root().text());
  const resultCount = Number(/(\d+)\s+resultados? encontrados/i.exec(pageText)?.[1] ?? results.length);
  const truncated = /somente os 30 primeiros/i.test(pageText)
    || messages.some((message) => /somente os 30 primeiros/i.test(message))
    || resultCount > results.length;
  const viewState = $("input[name='javax.faces.ViewState']").last().attr("value");

  return {
    results,
    resultCount: Number.isFinite(resultCount) ? resultCount : results.length,
    truncated,
    messages,
    ...(viewState ? { viewState } : {})
  };
}

export function parseDetailPage(html: string, pageUrl: string): DetailPage {
  const $ = cheerio.load(html);
  const fields: Record<string, string> = {};
  const processForm = tableBySuffix($, "processoEvento").closest("form").first();
  const detailsForm = processForm.length > 0
    ? processForm
    : $("form").has(".propertyView").first();
  detailsForm.find(".propertyView").each((_, property) => {
    const label = cleanText($, $(property).find(".name").first());
    const value = cleanText($, $(property).find(".value").first());
    if (!label || !value) {
      return;
    }
    fields[label] = fields[label] ? `${fields[label]} | ${value}` : value;
  });
  const movementPager = parsePager(html, pageUrl, "processoEvento");
  const documentPager = parsePager(html, pageUrl, "processoDocumentoGridTab");

  return {
    fields,
    parties: {
      active: parseParticipants($, "processoPartesPoloAtivoResumidoList"),
      passive: parseParticipants($, "processoPartesPoloPassivoResumidoList"),
      others: parseParticipants($, "processoParteOutrosInteressadosResumidoList")
    },
    movements: parseMovementRows(html),
    documents: parseDocumentRows(html, pageUrl),
    ...(movementPager ? { movementPager } : {}),
    ...(documentPager ? { documentPager } : {})
  };
}

export function parseMovementRows(html: string): MovementRecord[] {
  const $ = cheerio.load(html);
  const table = tableBySuffix($, "processoEvento");
  const movements: MovementRecord[] = [];

  table.find("tbody > tr.rich-table-row").each((_, row) => {
    const cells = $(row).children("td").map((__, cell) => cleanText($, $(cell))).get();
    if (cells.length === 0 || cells.every((cell) => cell.length === 0)) {
      return;
    }
    const description = normalizeText(cells.join(" | "));
    const dateTime = /\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}/.exec(description)?.[0];
    movements.push({
      description,
      cells,
      ...(dateTime ? { dateTime } : {})
    });
  });

  return movements;
}

export function parseDocumentRows(html: string, pageUrl: string): DocumentDiscovery[] {
  const $ = cheerio.load(html);
  const table = tableBySuffix($, "processoDocumentoGridTab");
  const documents: DocumentDiscovery[] = [];

  table.find("tbody > tr.rich-table-row").each((rowIndex, row) => {
    const rowSelection = $(row);
    const cells = rowSelection.children("td");
    if (cells.length === 0) {
      return;
    }
    const cellTexts = cells.map((_, cell) => cleanText($, $(cell))).get();
    const firstCell = cells.eq(0);
    const binaryLink = firstCell.find("a[href*='idBin='][href*='idProcessoDocumento=']").first();
    const htmlLink = firstCell.find("a[onclick*='documentoSemLoginHTML.seam']").first();
    const binaryUrl = binaryLink.attr("href");
    const htmlUrl = extractPopupUrl(
      htmlLink.attr("onclick") ?? "",
      "documentoSemLoginHTML.seam"
    );
    const primaryText = cleanText($, binaryLink.length > 0 ? binaryLink : htmlLink);
    const parsed = parseDocumentTitle(primaryText || cellTexts[0] || "Documento");
    const primaryUrl = binaryUrl
      ? resolveCleanUrl(binaryUrl, pageUrl)
      : htmlUrl
        ? resolveCleanUrl(htmlUrl, pageUrl)
        : undefined;
    const primaryDocumentId = primaryUrl ? documentIdFromUrl(primaryUrl) : undefined;
    const fallbackKey = `${cellTexts.join("|")}:${rowIndex}`;
    const documentId = primaryDocumentId ?? `unknown-${stableId(fallbackKey)}`;
    const resources = [];

    if (binaryUrl) {
      resources.push({
        id: `${documentId}:document`,
        kind: "document" as const,
        documentId,
        title: parsed.title,
        sourceUrl: resolveCleanUrl(binaryUrl, pageUrl)
      });
    } else if (htmlUrl) {
      resources.push({
        id: `${documentId}:generated`,
        kind: "generated" as const,
        documentId,
        title: parsed.title,
        sourceUrl: resolveCleanUrl(htmlUrl, pageUrl)
      });
    }

    const receiptControl = rowSelection
      .find("a[onclick*='reportReciboPDF.seam'], a[href*='reportReciboPDF.seam']")
      .first();
    const receiptSource = receiptControl.attr("href")?.includes("reportReciboPDF.seam")
      ? receiptControl.attr("href")
      : extractPopupUrl(receiptControl.attr("onclick") ?? "", "reportReciboPDF.seam");
    if (receiptSource) {
      const receiptUrl = resolveCleanUrl(receiptSource, pageUrl);
      const parameters = new URL(receiptUrl).searchParams;
      if (["idBin", "idProcessoDoc", "idProcessoTrf"].every((name) => parameters.has(name))) {
        resources.push({
          id: `${documentId}:receipt`,
          kind: "receipt" as const,
          documentId,
          title: `${parsed.title} - recibo`,
          sourceUrl: receiptUrl
        });
      }
    }

    documents.push({
      document: {
        documentId,
        title: parsed.title,
        sourceType: binaryUrl ? "binary" : htmlUrl ? "html" : "unknown",
        cells: cellTexts,
        pdfs: [],
        ...(parsed.dateTime ? { dateTime: parsed.dateTime } : {}),
        ...(parsed.documentType ? { documentType: parsed.documentType } : {})
      },
      resources
    });
  });

  return documents;
}

export function parsePager(
  html: string,
  pageUrl: string,
  tableSuffix: string
): PagerState | undefined {
  const $ = cheerio.load(html);
  const table = tableBySuffix($, tableSuffix);
  if (table.length === 0) {
    return undefined;
  }
  const scope = table.closest(".rich-panel-body").length > 0
    ? table.closest(".rich-panel-body")
    : table.parent();
  const slider = scope.find("input.rich-inslider-field").first();
  if (slider.length === 0) {
    return undefined;
  }
  // RichFaces 3 stores pager request identifiers in generated JavaScript instead of ordinary form controls.
  const form = slider.closest("form");
  const sliderBaseId = (slider.attr("id") ?? "").replace(/Input$/, "");
  const scriptText = scope.find("script")
    .map((_, element) => $(element).text())
    .get()
    .find((text) => text.includes("new Richfaces.Slider") && text.includes(sliderBaseId));
  if (!scriptText) {
    throw new Error(`No se pudo interpretar el paginador ${tableSuffix}: falta su configuración`);
  }
  const script = normalizeJavascript(scriptText);
  const formId = form.attr("id");
  const sliderName = slider.attr("name");
  const eventId = /'similarityGroupingId'\s*:\s*'([^']+)'/.exec(script)?.[1];
  const containerId = /'containerId'\s*:\s*'([^']+)'/.exec(script)?.[1];
  const maxPage = Number(/'maxValue'\s*:\s*'(\d+)'/.exec(script)?.[1]);
  const page = Number(slider.attr("value") ?? /'sliderValue'\s*:\s*'(\d+)'/.exec(script)?.[1]);
  const action = /'actionUrl'\s*:\s*'([^']+)'/.exec(script)?.[1]
    ?? form.attr("action")
    ?? pageUrl;
  const fields = collectFormFields($, form);
  const viewState = fields["javax.faces.ViewState"];

  if (!formId || !sliderName || !eventId || !containerId || !viewState
    || !Number.isSafeInteger(maxPage) || maxPage < 1
    || !Number.isSafeInteger(page) || page < 1) {
    throw new Error(`No se pudo interpretar el paginador ${tableSuffix}: configuración incompleta`);
  }

  return {
    actionUrl: resolveCleanUrl(decodeJavascriptEscapes(action), pageUrl),
    containerId,
    eventId,
    fields,
    formId,
    maxPage,
    page,
    sliderName,
    viewState
  };
}

export function buildPagerFields(pager: PagerState, page: number): URLSearchParams {
  if (!Number.isSafeInteger(page) || page < 1 || page > pager.maxPage) {
    throw new RangeError(`Página fuera del rango 1-${pager.maxPage}`);
  }
  const fields = { ...pager.fields };
  fields[pager.formId] = pager.formId;
  fields[pager.sliderName] = String(page);
  fields[pager.eventId] = pager.eventId;
  fields["javax.faces.ViewState"] = pager.viewState;
  const parameters = new URLSearchParams();
  parameters.set("AJAXREQUEST", pager.containerId);
  for (const [name, value] of Object.entries(fields)) {
    parameters.set(name, value);
  }
  parameters.set("AJAX:EVENTS_COUNT", "1");
  return parameters;
}

export function parseHtmlPdfForm(html: string, pageUrl: string): HtmlPdfForm {
  const $ = cheerio.load(html);
  const control = $("a[id$=':downloadPDF']").first();
  const form = control.closest("form");
  const formId = form.attr("id");
  if (control.length === 0 || form.length === 0 || !formId) {
    throw new Error("El documento HTML no ofrece la acción Gerar PDF");
  }
  const fields = collectFormFields($, form);
  fields[formId] = formId;
  const onclick = control.attr("onclick") ?? "";
  const pairPattern = /['"]([^'"]+)['"]\s*:\s*['"]([^'"]*)['"]/g;
  for (const match of onclick.matchAll(pairPattern)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      fields[name] = decodeJavascriptEscapes(value);
    }
  }
  const source = control.attr("id");
  if (source) {
    fields[source] = source;
  }

  return {
    actionUrl: resolveCleanUrl(form.attr("action") ?? pageUrl, pageUrl),
    fields
  };
}

function parseParticipants($: CheerioAPI, tableSuffix: string): ParticipantRecord[] {
  const participants: ParticipantRecord[] = [];
  tableBySuffix($, tableSuffix).find("tbody > tr.rich-table-row").each((_, row) => {
    const cells = $(row).children("td").map((__, cell) => cleanText($, $(cell))).get();
    if (cells.length === 0) {
      return;
    }
    participants.push({
      participant: cells[0] ?? "",
      status: cells[1] ?? "",
      cells
    });
  });
  return participants;
}

function tableBySuffix($: CheerioAPI, suffix: string): Selection {
  return $(`table[id$=":${escapeAttribute(suffix)}"]`).first();
}

function collectFormFields($: CheerioAPI, form: Selection): Record<string, string> {
  const fields: Record<string, string> = {};
  form.find("input[name], textarea[name], select[name]").each((_, element) => {
    const control = $(element);
    const name = control.attr("name");
    if (!name) {
      return;
    }
    const tag = element.tagName.toLowerCase();
    const type = (control.attr("type") ?? "text").toLowerCase();
    if (tag === "input" && ["button", "submit", "reset", "image", "file"].includes(type)) {
      return;
    }
    if (tag === "input" && ["checkbox", "radio"].includes(type) && !control.is(":checked")) {
      return;
    }
    if (tag === "select") {
      fields[name] = control.find("option:selected").first().attr("value")
        ?? control.find("option").first().attr("value")
        ?? "";
      return;
    }
    fields[name] = control.attr("value") ?? control.text() ?? "";
  });
  return fields;
}

function cleanText($: CheerioAPI, selection: Selection): string {
  const clone = selection.clone();
  clone.find("script, style, .sr-only").remove();
  return normalizeText(clone.text());
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function resolveCleanUrl(value: string, baseUrl: string): string {
  const url = new URL(decodeJavascriptEscapes(value).replace(/&amp;/g, "&"), baseUrl);
  url.pathname = url.pathname.replace(/;jsessionid=[^/;?]+/i, "");
  return url.toString();
}

function extractPopupUrl(onclick: string, marker: string): string | undefined {
  const normalized = decodeJavascriptEscapes(onclick).replace(/&amp;/g, "&");
  const candidates = [...normalized.matchAll(/['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  return candidates.find((value) => value.includes(marker));
}

function extractSearchSource(script: string): string | undefined {
  return /parameters'\s*:\s*\{'([^']+)'\s*:\s*'\1'/.exec(script)?.[1];
}

function documentIdFromUrl(value: string): string | undefined {
  const url = new URL(value);
  return url.searchParams.get("idProcessoDocumento")
    ?? url.searchParams.get("idProcessoDoc")
    ?? url.searchParams.get("idBin")
    ?? undefined;
}

function parseDocumentTitle(value: string): {
  dateTime?: string;
  title: string;
  documentType?: string;
} {
  const normalized = normalizeText(value);
  const dateTime = /^(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})\s*-\s*/.exec(normalized)?.[1];
  const withoutDate = dateTime
    ? normalized.replace(/^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}\s*-\s*/, "")
    : normalized;
  const documentType = /\(([^()]*)\)\s*$/.exec(withoutDate)?.[1];
  const title = normalizeText(documentType
    ? withoutDate.replace(/\s*\([^()]*\)\s*$/, "")
    : withoutDate) || "Documento";
  return {
    title,
    ...(dateTime ? { dateTime } : {}),
    ...(documentType ? { documentType } : {})
  };
}

function setBySuffix(fields: Record<string, string>, suffix: string, value: string): void {
  const name = Object.keys(fields).find((candidate) => candidate.endsWith(suffix));
  if (!name) {
    throw new Error(`No se encontró el campo JSF ${suffix}`);
  }
  fields[name] = value;
}

function monthYear(date: string): string {
  const [, month = "", year = ""] = date.split("/");
  return `${month}/${year}`;
}

function normalizeJavascript(value: string): string {
  return decodeJavascriptEscapes(value).replace(/\\'/g, "'").replace(/\\"/g, "\"");
}

function decodeJavascriptEscapes(value: string): string {
  return value.replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function removeLeading(value: string, prefix: string): string {
  return prefix && value.startsWith(prefix) ? normalizeText(value.slice(prefix.length)) : value;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeAttribute(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
