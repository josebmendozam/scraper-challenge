export interface SearchCriteria {
  processNumber?: string;
  from?: string;
  to?: string;
}

export interface SearchFormState {
  actionUrl: string;
  fields: Record<string, string>;
  searchSource: string;
  viewState: string;
  captchaEnabled: boolean;
}

export interface SearchResult {
  processId: string;
  processNumber: string;
  className: string;
  title: string;
  partySummary: string;
  lastMovement: string;
  detailUrl: string;
}

export interface SearchResponse {
  results: SearchResult[];
  resultCount: number;
  truncated: boolean;
  messages: string[];
  viewState?: string;
}

export interface ParticipantRecord {
  participant: string;
  status: string;
  cells: string[];
}

export interface MovementRecord {
  dateTime?: string;
  description: string;
  cells: string[];
}

export type PdfKind = "document" | "generated" | "receipt";

export interface PdfResource {
  id: string;
  kind: PdfKind;
  documentId: string;
  title: string;
  sourceUrl: string;
}

export interface PdfRecord {
  id: string;
  kind: PdfKind;
  title: string;
  status: "downloaded" | "skipped" | "failed";
  attempts: number;
  file?: string;
  bytes?: number;
  error?: string;
}

export interface DocumentRecord {
  documentId: string;
  dateTime?: string;
  title: string;
  documentType?: string;
  sourceType: "binary" | "html" | "unknown";
  cells: string[];
  pdfs: PdfRecord[];
}

export interface DocumentDiscovery {
  document: DocumentRecord;
  resources: PdfResource[];
}

export interface PagerState {
  actionUrl: string;
  containerId: string;
  eventId: string;
  fields: Record<string, string>;
  formId: string;
  maxPage: number;
  page: number;
  sliderName: string;
  viewState: string;
}

export interface DetailPage {
  fields: Record<string, string>;
  parties: {
    active: ParticipantRecord[];
    passive: ParticipantRecord[];
    others: ParticipantRecord[];
  };
  movements: MovementRecord[];
  documents: DocumentDiscovery[];
  movementPager?: PagerState;
  documentPager?: PagerState;
}

export interface HtmlPdfForm {
  actionUrl: string;
  fields: Record<string, string>;
}

export interface ProcessRecord {
  processId: string;
  processNumber: string;
  scrapedAt: string;
  query: SearchCriteria;
  summary: {
    className: string;
    title: string;
    partySummary: string;
    lastMovement: string;
  };
  fields: Record<string, string>;
  parties: DetailPage["parties"];
  movements: MovementRecord[];
  documents: DocumentRecord[];
}

export interface DownloadFailure {
  id: string;
  processId: string;
  processNumber: string;
  documentId: string;
  kind: PdfKind;
  title: string;
  attempts: number;
  httpStatus?: number;
  error: string;
  query: SearchCriteria;
  updatedAt: string;
}

export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  query: SearchCriteria;
  searchResultCount: number;
  truncated: boolean;
  processedProcesses: number;
  discoveredDocuments: number;
  downloadedPdfs: number;
  skippedPdfs: number;
  failedPdfs: number;
  processErrors: Array<{
    processId: string;
    processNumber: string;
    error: string;
  }>;
}
