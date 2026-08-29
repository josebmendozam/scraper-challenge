# TRF5 PJe Scraper Challenge

Scraper browserless en TypeScript para la consulta pública del PJe del Tribunal Regional Federal da 5ª Região. Mantiene la sesión JSF/Seam, recorre las páginas RichFaces de movimientos y documentos, extrae los datos visibles y descarga los PDFs de forma idempotente.

## Requisitos

- Node.js 20 o superior
- npm 10 o superior
- Acceso HTTPS a `pjett.trf5.jus.br`

No usa Puppeteer, Playwright, Selenium, WebDriver ni un navegador embebido.

## Instalación

```bash
npm ci
npm run build
```

## Ejecución

La forma más confiable de obtener un conjunto completo es buscar un número CNJ exacto:

```bash
npm run scrape -- --process 0006388-48.1986.4.05.8401
```

También se puede consultar por fecha de autuación:

```bash
npm run scrape -- --from 01/08/2026 --to 01/08/2026
```

Una demostración acotada que extrae un proceso y descarga un PDF:

```bash
npm run scrape -- \
  --process 0006388-48.1986.4.05.8401 \
  --max-processes 1 \
  --max-downloads 1 \
  --delay-ms 1500
```

Para extraer únicamente metadatos:

```bash
npm run scrape -- \
  --process 0006388-48.1986.4.05.8401 \
  --skip-pdfs
```

Consulta todas las opciones con:

```bash
npm run scrape -- --help
```

## Salida

Por defecto se crea `data/`:

```text
data/
├── failed-downloads.json (solo cuando hubo fallos)
├── run-summary.json
├── processes/
│   └── <proceso>-<hash>.json
└── pdfs/
    └── <proceso>-<hash>/
        └── <documento>--<tipo>--<nombre>--<hash>.pdf
```

- `processes/` contiene campos del proceso, partes, movimientos y todos los documentos descubiertos.
- `pdfs/` contiene archivos validados por `Content-Type` y firma `%PDF-`.
- `failed-downloads.json` mantiene el último fallo por recurso sin guardar cookies, `ViewState`, `ca`, `cid` ni URLs efímeras.
- `run-summary.json` indica si la búsqueda fue completa, cuántos registros se procesaron y el resultado de las descargas.

Los JSON y PDFs se escriben primero en archivos temporales y se renombran de forma atómica. Una nueva ejecución con los mismos argumentos omite PDFs válidos existentes, reintenta los fallidos y elimina su entrada del registro cuando finalizan correctamente.

## Rate limiting

Las descargas son secuenciales. Ante `429 Too Many Requests`, `408` o errores `5xx`, el scraper:

1. Respeta `Retry-After` cuando el servidor lo envía.
2. Usa backoff exponencial con jitter en los demás casos.
3. Reintenta hasta `--max-attempts`.
4. Registra el fallo y continúa con el siguiente PDF cuando se agotan los intentos.

Los valores conservadores por defecto son un segundo entre requests, cinco intentos y dos segundos como base del backoff. El backoff calculado se limita a 60 segundos con esos valores; un `Retry-After` mayor se respeta completo.

## Flujo técnico

El portal usa JSF/Seam y RichFaces 3.3.3. El scraper reproduce únicamente las operaciones HTTP necesarias:

1. Obtiene la página inicial y conserva `JSESSIONID`, `ROUTER_ID` y cookies del balanceador.
2. Extrae el formulario, los nombres de componentes generados y `javax.faces.ViewState`.
3. Envía la búsqueda como formulario RichFaces y analiza el fragmento XHTML devuelto.
4. Abre cada detalle con el mismo cookie jar.
5. Detecta los sliders RichFaces y recorre cada página en secuencia con sus identificadores actuales.
6. Descarga PDFs binarios, genera PDFs para documentos HTML y descarga recibos cuando están disponibles.

Los identificadores `j_idNNN` se descubren en cada respuesta; no están codificados como constantes.

## Límite del buscador público

El buscador limita una consulta amplia a los primeros 30 procesos y no presenta un paginador para continuar. El propio portal muestra:

> Sua consulta retornou muitos processos e somente os 30 primeiros serão exibidos. Por favor, refine sua pesquisa.

Por esa razón, el scraper marca la consulta como truncada y se detiene por defecto. `--allow-truncated` permite procesar esos 30 resultados para una demostración, pero no los presenta como un conjunto completo. Incluso un solo día puede superar el límite; con los filtros públicos expuestos por el sitio no sería correcto afirmar que una búsqueda amplia enumera todo el corpus.

## CAPTCHA y errores del sitio

La página carga reCAPTCHA, pero durante la investigación del sitio la condición de ejecución estaba deshabilitada por el propio servidor. El scraper detecta si esa condición cambia y se detiene con un mensaje claro; no intenta eludir un CAPTCHA.

Una página de login, un error inesperado o HTML recibido durante una descarga nunca se guarda como PDF. Esos casos quedan registrados para una ejecución posterior.

## Calidad

```bash
npm run lint
npm test
npm run check
```

Las pruebas usan fixtures sanitizados y servidores HTTP locales. No realizan un scrape completo ni descargan información judicial durante CI.
