import { getHelpText, parseCli } from "./cli.js";
import { runScraper } from "./scraper.js";

async function main(): Promise<void> {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      console.log(getHelpText());
      return;
    }

    const summary = await runScraper(options);
    console.log(
      `Finalizado: ${summary.processedProcesses} procesos, ${summary.discoveredDocuments} documentos, ${summary.downloadedPdfs} PDFs descargados, ${summary.skippedPdfs} omitidos y ${summary.failedPdfs} fallidos`
    );
    if (summary.failedPdfs > 0 || summary.processErrors.length > 0) {
      process.exitCode = 2;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${redact(message)}`);
    process.exitCode = 1;
  }
}

function redact(value: string): string {
  return value
    .replace(/(ca|cid|jsessionid)=[^&\s"']+/gi, "$1=[redacted]")
    .replace(/;jsessionid=[^?\s"']+/gi, ";jsessionid=[redacted]");
}

await main();
