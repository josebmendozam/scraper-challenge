# TRF5 PJe Scraper Challenge

Scraper browserless en TypeScript para la consulta pública del PJe del Tribunal Regional Federal da 5ª Região. Mantiene la sesión JSF/Seam, recorre las páginas RichFaces de movimientos y documentos, extrae los datos visibles y descarga los PDFs de forma idempotente.

## Requisitos

- Node.js 20.18.1 o superior
- npm 10 o superior
- Acceso HTTPS a `pjett.trf5.jus.br`

No usa Puppeteer, Playwright, Selenium, WebDriver ni un navegador embebido.

## Instalación

```bash
npm ci
npm run build
```

## Ejecución

Extraer un proceso completo:

```bash
npm run scrape -- --process 0006388-48.1986.4.05.8401
```

El comando recorre todas las páginas de movimientos y documentos del proceso y descarga todos sus PDFs asociados.

Extraer los procesos de un rango de fechas:

```bash
npm run scrape -- --from 01/08/2026 --to 01/08/2026
```

El buscador público limita las consultas amplias a 30 procesos. Si el portal indica que el resultado fue truncado, el scraper se detiene para no presentar una extracción incompleta. Refina el rango o usa `--allow-truncated` si quieres procesar deliberadamente solo esos 30 resultados.

Ver todas las opciones:

```bash
npm run scrape -- --help
```

## Salida

La salida se guarda en `data/`:

- `processes/`: datos de procesos, partes, movimientos y documentos en JSON.
- `pdfs/`: PDFs organizados por proceso.
- `run-summary.json`: resumen de la ejecución.
- `failed-downloads.json`: descargas agotadas después de los reintentos, si las hubo.

Al repetir el mismo comando, los PDFs válidos existentes se omiten y las descargas fallidas se vuelven a intentar.

## Calidad

```bash
npm run check
npm run smoke
```

`npm run check` ejecuta lint y pruebas locales. `npm run smoke` comprueba manualmente el portal real, valida un PDF y elimina la salida temporal al terminar.
