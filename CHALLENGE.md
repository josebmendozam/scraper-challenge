# Desafío de Scraping

## 📋 Descripción del desafío

Tu tarea es crear un **scraper en TypeScript desde cero** que extraiga información del siguiente sitio web. El scraper debe navegar por todas las páginas, extraer los datos de cada documento y descargar los PDFs asociados, manejando correctamente los errores de rate limiting.

### 🌐 Sitio web a scrapear

**URL:** https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam

**Nota:** Nosotros ya poseemos esta información. Este scraper se utilizará únicamente como desafío de scraping.

---

## 🚀 Configuración del entorno

### Paso 1: Explorar el sitio web

Antes de comenzar a desarrollar, explora el sitio para entender su estructura.

- Abre tu navegador y visita: https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam
- Explora el sitio para entender su estructura, navegación y funcionalidades.
- Identifica cómo se organizan los documentos y cómo acceder a ellos.
- Descubre cómo funciona la descarga de PDFs.

### Paso 2: Crear tu proyecto de scraper

Crea un nuevo proyecto desde cero:

```bash
mkdir scraper-challenge
cd scraper-challenge
npm init -y
npm install --save-dev typescript @types/node ts-node
npm install axios cheerio
```

No usar librerías que controlen un navegador (ej: Puppeteer, Playwright, Selenium).

---

## ✅ Requerimientos funcionales

### 1. 📄 Navegación y extracción

- Navegar por todo el sitio web.
- Extraer toda la información disponible de cada documento.
- Debes descubrir la estructura del sitio, cómo funciona la paginación y qué información está disponible como parte del desafío.

### 2. 📥 Descarga de PDFs

- Implementar la capacidad de descargar los PDFs asociados a los documentos.
- Guardar cada PDF con un nombre descriptivo.
- No es necesario descargar todos los documentos en una sola ejecución para la entrega. Basta con demostrar que el scraper puede llegar a descargarlos todos si se deja corriendo hasta el final.
- Debes descubrir cómo acceder y descargar los PDFs como parte del desafío.

### 3. ⚠️ Manejo de errores 429

Las descargas de PDFs pueden retornar un error **429 (Too Many Requests)**. Tu scraper debe:

- Detectar cuando ocurre un error 429.
- Implementar un sistema de reintentos con backoff exponencial.
- Continuar con el siguiente documento si el error persiste después de varios intentos.
- Registrar qué documentos fallaron para poder reintentarlos después.

---

## 🛠️ Requerimientos técnicos

### Lenguaje y tecnologías

- ✅ **TypeScript** es obligatorio.
- ✅ El scraper debe hacerse **sin automatización de navegador**.
- **No se permite** usar librerías basadas en browser o WebDriver (por ejemplo: Puppeteer, Playwright, Selenium).
- Debe resolverse usando **requests HTTP** (por ejemplo: `axios`/`fetch`) y parsing (por ejemplo: `cheerio`).
- El código debe estar bien estructurado y documentado.

### Estructura del proyecto

Tu repositorio debe incluir:

- Código fuente del scraper en TypeScript.
- `package.json` con todas las dependencias.
- `README.md` explicando cómo ejecutar el scraper.
- `.gitignore` apropiado.
- Scripts de ejecución en `package.json` opcionales.

---

## 📦 Entregable

1. **Crear el scraper**
   - Desarrolla el scraper desde cero en TypeScript.
   - Asegúrate de que funcione correctamente con el sitio: https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam
2. **Repositorio en GitHub**
   - Crea un **nuevo repositorio público** en GitHub.
   - Sube todo el código del scraper.
   - Asegúrate de que el repositorio sea accesible públicamente.
   - El README debe incluir instrucciones claras de instalación y ejecución.
3. **Compartir el repositorio**
   - Comparte el enlace del repositorio con el equipo.
   - El código debe estar completo y funcional.

---

## 🎓 Criterios de evaluación

- ✅ **Funcionalidad**: El scraper extrae correctamente todos los datos.
- ✅ **Manejo de errores**: Implementa correctamente el manejo de errores 429.
- ✅ **Código limpio**: Código bien estructurado, documentado y fácil de entender.
- ✅ **Robustez**: Maneja edge cases y errores inesperados.
- ✅ **Documentación**: README claro y completo.

---

## 💡 Tips y recomendaciones

- 🕐 Implementa delays entre requests para evitar sobrecargar el servidor.
- 🔄 Usa estrategias de retry inteligentes para los errores 429.
- 📝 Guarda los datos extraídos en un formato estructurado (JSON, CSV, etc.).
- 🧪 Prueba tu scraper con un subconjunto de documentos antes de ejecutarlo completo.
- 📊 Considera agregar logging para monitorear el progreso.
- 💾 Guarda los PDFs en una carpeta organizada.

¡Buena suerte! 🚀 Si tienes preguntas, no dudes en consultar con el equipo.
