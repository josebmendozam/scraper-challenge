import path from "node:path";
import type { SearchCriteria } from "./types.js";

const DEFAULT_BASE_URL = "https://pjett.trf5.jus.br/pjeconsulta/";

export interface CliOptions {
  allowTruncated: boolean;
  backoffMs: number;
  baseUrl: string;
  criteria: SearchCriteria;
  delayMs: number;
  help: boolean;
  maxAttempts: number;
  maxDownloads: number;
  maxProcesses: number;
  outputDir: string;
  skipPdfs: boolean;
  timeoutMs: number;
}

const helpText = `
TRF5 PJe scraper

Uso:
  npm run scrape -- --process 0803948-93.2020.4.05.8000
  npm run scrape -- --from 01/08/2026 --to 01/08/2026

Opciones:
  --process <número>       Busca un proceso CNJ exacto
  --from <DD/MM/YYYY>      Fecha inicial de autuación
  --to <DD/MM/YYYY>        Fecha final de autuación
  --output <directorio>    Directorio de salida (data)
  --delay-ms <n>           Espera mínima entre requests (1000)
  --timeout-ms <n>         Timeout por request (30000)
  --max-attempts <n>       Intentos máximos de descarga (5)
  --backoff-ms <n>         Base del backoff exponencial (2000)
  --max-processes <n>      Límite de procesos para una demostración
  --max-downloads <n>      Límite global de PDFs para una demostración
  --skip-pdfs              Extrae datos sin descargar PDFs
  --allow-truncated        Acepta los primeros 30 resultados de una búsqueda truncada
  --base-url <url>         URL base para pruebas o un despliegue compatible
  --help                   Muestra esta ayuda
`.trim();

export function getHelpText(): string {
  return helpText;
}

export function parseCli(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set([
    "--process",
    "--from",
    "--to",
    "--output",
    "--delay-ms",
    "--timeout-ms",
    "--max-attempts",
    "--backoff-ms",
    "--max-processes",
    "--max-downloads",
    "--base-url"
  ]);
  const flagOptions = new Set(["--skip-pdfs", "--allow-truncated", "--help"]);

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option) {
      continue;
    }
    if (flagOptions.has(option)) {
      flags.add(option);
      continue;
    }
    if (!valueOptions.has(option)) {
      throw new Error(`Opción desconocida: ${option}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Falta el valor de ${option}`);
    }
    values.set(option, value);
    index += 1;
  }

  const help = flags.has("--help");
  const processNumber = values.get("--process");
  const from = values.get("--from");
  const to = values.get("--to");

  if (!help) {
    validateCriteria(processNumber, from, to);
  }

  const criteria: SearchCriteria = {};
  if (processNumber) {
    criteria.processNumber = formatProcessNumber(processNumber);
  }
  if (from) {
    criteria.from = validateDate(from, "--from");
  }
  if (to) {
    criteria.to = validateDate(to, "--to");
  }
  if (criteria.from && criteria.to && toTimestamp(criteria.from) > toTimestamp(criteria.to)) {
    throw new Error("--from no puede ser posterior a --to");
  }

  return {
    allowTruncated: flags.has("--allow-truncated"),
    backoffMs: positiveInteger(values.get("--backoff-ms"), 2_000, "--backoff-ms"),
    baseUrl: normalizeBaseUrl(values.get("--base-url") ?? DEFAULT_BASE_URL),
    criteria,
    delayMs: nonNegativeInteger(values.get("--delay-ms"), 1_000, "--delay-ms"),
    help,
    maxAttempts: positiveInteger(values.get("--max-attempts"), 5, "--max-attempts"),
    maxDownloads: positiveInteger(values.get("--max-downloads"), Number.MAX_SAFE_INTEGER, "--max-downloads"),
    maxProcesses: positiveInteger(values.get("--max-processes"), Number.MAX_SAFE_INTEGER, "--max-processes"),
    outputDir: path.resolve(values.get("--output") ?? "data"),
    skipPdfs: flags.has("--skip-pdfs"),
    timeoutMs: positiveInteger(values.get("--timeout-ms"), 30_000, "--timeout-ms")
  };
}

function validateCriteria(processNumber: string | undefined, from: string | undefined, to: string | undefined): void {
  if (processNumber && (from || to)) {
    throw new Error("Use --process o el par --from/--to, no ambos");
  }
  if (!processNumber && (!from || !to)) {
    throw new Error("Informe --process o ambas fechas --from y --to");
  }
}

function formatProcessNumber(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 20) {
    throw new Error("--process debe contener los 20 dígitos del número CNJ");
  }
  return `${digits.slice(0, 7)}-${digits.slice(7, 9)}.${digits.slice(9, 13)}.${digits.slice(13, 14)}.${digits.slice(14, 16)}.${digits.slice(16)}`;
}

function validateDate(value: string, option: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) {
    throw new Error(`${option} debe usar DD/MM/YYYY`);
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${option} contiene una fecha inválida`);
  }
  return value;
}

function toTimestamp(value: string): number {
  const [day = "", month = "", year = ""] = value.split("/");
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function positiveInteger(value: string | undefined, fallback: number, option: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} debe ser un entero positivo`);
  }
  return parsed;
}

function nonNegativeInteger(value: string | undefined, fallback: number, option: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${option} debe ser un entero no negativo`);
  }
  return parsed;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("--base-url debe usar HTTP o HTTPS");
  }
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}
