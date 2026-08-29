import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPagerFields,
  buildSearchFields,
  parseDetailPage,
  parseHtmlPdfForm,
  parsePager,
  parseSearchForm,
  parseSearchResponse
} from "../src/parsers.js";

const baseUrl = "https://example.test/pjeconsulta/ConsultaPublica/listView.seam";

test("parses and submits the dynamic public search form", () => {
  const html = `
    <form id="fPP" action="/pjeconsulta/ConsultaPublica/listView.seam;jsessionid=secret">
      <input name="fPP" value="fPP">
      <input name="fPP:numProcesso-inputNumeroProcessoDecoration:numProcesso-inputNumeroProcesso" value="">
      <input name="fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate" value="">
      <input name="fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputCurrentDate" value="08/2026">
      <input name="fPP:dataAutuacaoDecoration:dataAutuacaoFimInputDate" value="">
      <input name="fPP:dataAutuacaoDecoration:dataAutuacaoFimInputCurrentDate" value="08/2026">
      <input name="javax.faces.ViewState" value="j_id1">
    </form>
    <script>function executarReCaptcha(){if (false) { grecaptcha.execute(); }}</script>
    <script id="fPP:j_id244">executarPesquisa=function(){A4J.AJAX.Submit('fPP',null,{})}</script>
  `;
  const form = parseSearchForm(html, baseUrl);
  const fields = buildSearchFields(form, { from: "01/07/2026", to: "02/07/2026" });

  assert.equal(form.captchaEnabled, false);
  assert.equal(form.actionUrl, baseUrl);
  assert.equal(fields.get("AJAXREQUEST"), "_viewRoot");
  assert.equal(fields.get("fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate"), "01/07/2026");
  assert.equal(fields.get("fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputCurrentDate"), "07/2026");
  assert.equal(fields.get("fPP:j_id244"), "fPP:j_id244");
});

test("parses search rows and detects the server hard cap", () => {
  const rows = Array.from({ length: 30 }, (_, index) => `
    <tr class="rich-table-row">
      <td id="fPP:processosTable:${100 + index}:open"><a onclick="openPopUp('Consulta','/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=opaque-${index}')">Abrir</a></td>
      <td>APELAÇÃO CÍVEL <a onclick="openPopUp('Consulta','/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=opaque-${index}')">ApCiv 000000${index % 10}-00.2026.4.05.8000 - Tema</a> PARTE A X PARTE B</td>
      <td>Movimento (${String(index + 1).padStart(2, "0")}/08/2026 10:00:00)</td>
    </tr>
  `).join("");
  const response = parseSearchResponse(`
    <div class="alert alert-danger">Sua consulta retornou muitos processos e somente os 30 primeiros serão exibidos.</div>
    <table id="fPP:processosTable"><tbody>${rows}</tbody></table>
    <span>30 resultados encontrados</span>
  `, baseUrl);

  assert.equal(response.results.length, 30);
  assert.equal(response.results[0]?.processId, "100");
  assert.equal(response.results[0]?.className, "APELAÇÃO CÍVEL");
  assert.equal(response.results[0]?.partySummary, "PARTE A X PARTE B");
  assert.equal(response.truncated, true);

  const completeResponse = parseSearchResponse(`
    <table id="fPP:processosTable"><tbody>${rows}</tbody></table>
    <span>30 resultados encontrados</span>
  `, baseUrl);
  assert.equal(completeResponse.results.length, 30);
  assert.equal(completeResponse.truncated, false);

  const movedWarningResponse = parseSearchResponse(`
    <p>Sua consulta retornou muitos processos e somente os 30 primeiros serão exibidos.</p>
    <table id="fPP:processosTable"><tbody>${rows}</tbody></table>
    <span>30 resultados encontrados</span>
  `, baseUrl);
  assert.equal(movedWarningResponse.truncated, true);
});

test("parses detail fields, parties, movements, document resources, and pager", () => {
  const html = `
    <form id="j_id146:processoTrfViewView">
      <div class="propertyView"><div class="name">Número Processo</div><div class="value">0000001-00.2026.4.05.8000</div></div>
      <div class="propertyView"><div class="name">Classe Judicial</div><div class="value">Apelação</div></div>
    </form>
    <table id="j_id146:processoPartesPoloAtivoResumidoList"><tbody><tr class="rich-table-row"><td>PARTE PÚBLICA</td><td>Ativo</td></tr></tbody></table>
    <div class="rich-panel-body">
      <table id="j_id146:processoEvento"><tbody><tr class="rich-table-row"><td>01/08/2026 10:20:30 - Juntada de documento</td></tr></tbody></table>
    </div>
    <div class="rich-panel-body">
      <table id="j_id146:processoDocumentoGridTab"><tbody>
        <tr class="rich-table-row"><td><a href="/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam;jsessionid=secret?idBin=11&amp;idProcessoDocumento=22&amp;actionMethod=x">01/08/2026 10:20:30 - Decisão (Decisão)</a></td><td></td></tr>
        <tr class="rich-table-row"><td><a href="#" onclick="openPopUp('doc','/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/documentoSemLoginHTML.seam?ca=opaque&amp;idProcessoDoc=33')">02/08/2026 11:00:00 - Despacho (Despacho)</a></td><td><a onclick="openPopUp('recibo','/pjeconsulta/Processo/reportReciboPDF.seam?idBin=44&amp;idProcessoDoc=33&amp;idProcessoTrf=55')">Recibo</a><a onclick="openPopUp('certidao','/pjeconsulta/Processo/reportCertidaoPDF.seam?idProcessoDoc=33')">Certidão</a></td></tr>
      </tbody></table>
      <form id="j_id146:j_id653" action="/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam">
        <input class="rich-inslider-field" id="j_id146:j_id653:j_id654Input" name="j_id146:j_id653:j_id654" value="1">
        <input name="j_id146:j_id653" value="j_id146:j_id653">
        <input name="javax.faces.ViewState" value="j_id2">
      </form>
      <script>new Richfaces.Slider("j_id146:j_id653:j_id654",{'maxValue':'2','sliderValue':'1','onchange':'A4J.AJAX.Submit('j_id146:j_id653',event,{'similarityGroupingId':'j_id146:j_id653:j_id655','actionUrl':'/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam','containerId':'j_id146:j_id569'})'})</script>
    </div>
  `;
  const detail = parseDetailPage(html, "https://example.test/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=opaque");

  assert.equal(detail.fields["Número Processo"], "0000001-00.2026.4.05.8000");
  assert.equal(detail.parties.active[0]?.participant, "PARTE PÚBLICA");
  assert.equal(detail.movements[0]?.dateTime, "01/08/2026 10:20:30");
  assert.equal(detail.documents[0]?.document.sourceType, "binary");
  assert.equal(detail.documents[0]?.resources[0]?.kind, "document");
  assert.equal(detail.documents[1]?.resources[0]?.kind, "generated");
  assert.equal(detail.documents[1]?.resources[1]?.kind, "receipt");
  assert.equal(detail.documents[1]?.resources.length, 2);
  assert.equal(detail.documentPager?.maxPage, 2);
  assert.doesNotMatch(detail.documents[0]?.resources[0]?.sourceUrl ?? "", /jsessionid/);
});

test("builds the exact RichFaces slider payload", () => {
  const html = `
    <div class="rich-panel-body">
      <table id="j_id1:processoEvento"><tbody></tbody></table>
      <form id="j_id1:pageForm" action="/detail">
        <input class="rich-inslider-field" id="j_id1:sliderInput" name="j_id1:slider" value="1">
        <input name="javax.faces.ViewState" value="j_id9">
      </form>
      <script>new Richfaces.Slider("j_id1:slider",{'maxValue':'3','sliderValue':'1','onchange':'A4J.AJAX.Submit('j_id1:pageForm',event,{'similarityGroupingId':'j_id1:event','actionUrl':'/detail','containerId':'j_id1:panel'})'})</script>
    </div>
  `;
  const pager = parsePager(html, baseUrl, "processoEvento");
  assert.ok(pager);
  const fields = buildPagerFields(pager, 2);
  assert.equal(fields.get("AJAXREQUEST"), "j_id1:panel");
  assert.equal(fields.get("j_id1:slider"), "2");
  assert.equal(fields.get("j_id1:event"), "j_id1:event");
});

test("rejects an incomplete RichFaces slider instead of losing pages", () => {
  const html = `
    <div class="rich-panel-body">
      <table id="j_id1:processoDocumentoGridTab"><tbody></tbody></table>
      <form id="j_id1:pageForm" action="/detail">
        <input class="rich-inslider-field" id="j_id1:sliderInput" name="j_id1:slider" value="1">
        <input name="javax.faces.ViewState" value="j_id9">
      </form>
    </div>
  `;

  assert.throws(
    () => parsePager(html, baseUrl, "processoDocumentoGridTab"),
    /No se pudo interpretar el paginador processoDocumentoGridTab/
  );
});

test("parses the JSF form that generates a PDF from an HTML document", () => {
  const form = parseHtmlPdfForm(`
    <form id="j_id42" action="/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/documentoSemLoginHTML.seam">
      <a id="j_id42:downloadPDF" onclick="jsfcljs(document.getElementById('j_id42'),{'j_id42:downloadPDF':'j_id42:downloadPDF','ca':'opaque','idProcDocBin':'5583583'},'')">Gerar PDF</a>
      <input name="javax.faces.ViewState" value="j_id2">
    </form>
  `, baseUrl);

  assert.equal(form.fields.j_id42, "j_id42");
  assert.equal(form.fields["j_id42:downloadPDF"], "j_id42:downloadPDF");
  assert.equal(form.fields.ca, "opaque");
  assert.equal(form.fields.idProcDocBin, "5583583");
  assert.equal(form.fields["javax.faces.ViewState"], "j_id2");
});
