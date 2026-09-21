import { test } from "node:test";
import assert from "node:assert/strict";
import { pageMessages, parseForm, withValues } from "../src/html.ts";
import { parseMappingPage, parseOverview, parseReport } from "../src/overview.ts";

// Minimal pages that keep the structure of the real IPT 3.3.0 markup (captured from a live IPT).
const overview = `
<div id="sources"><div class="source-item d-flex"><a href="source.do?r=x&amp;id=occ">occ</a> 411 bytes | 5 rows/7 columns | 21 Sept 2026</div></div>
<div id="mappings"><div class="mapping-item"><a href="mapping.do?r=x&amp;id=http%3A%2F%2Frs.tdwg.org%2Fdwc%2Fterms%2FOccurrence&amp;mid=0">occ Occurrence 7 terms</a>
  <a href="delete-mapping.do?r=x&amp;id=http%3A%2F%2Frs.tdwg.org%2Fdwc%2Fterms%2FOccurrence&amp;mid=0">del</a></div></div>
<div id="metadata">Metadata Validation report Invalid</div>
<div id="visibility"><span class="badge">Private</span> This resource is currently private but its visibility has been changed to public. It will take effect after the resource is republished.</div>
<div id="publish"><div><strong>Version 1.0</strong><span class="version-pill version-current">CURRENT</span></div><div><strong>Version 1.1</strong><span class="version-pill version-next">PENDING</span></div></div>
<div id="metadata-validation-result-modal"><div class="modal-body"><h5>Metadata validation result</h5><div class="mt-2">
  <div><b>Basic Metadata</b><ul><li>eml.title: Title is required.</li><li>Description is required.</li></ul></div>
  <div><b>Contacts</b><ul><li>At least one contact is required</li></ul></div>
</div></div></div>`;

test("parseOverview: sources, mappings (deduplicated), versions, visibility, metadata problems", () => {
  const st = parseOverview("x", overview);
  assert.deepEqual(st.sources.map((s) => [s.name, s.rows, s.columns]), [["occ", 5, 7]]);
  assert.deepEqual(st.mappings.map((m) => [m.rowType, m.mid]), [["http://rs.tdwg.org/dwc/terms/Occurrence", 0]]);
  assert.equal(st.lastPublishedVersion, "1.0");
  assert.equal(st.nextVersion, "1.1");
  assert.equal(st.visibility, "private");
  assert.equal(st.visibilityChangePending, true);
  assert.deepEqual(st.metadataProblems, [
    { section: "Basic Metadata", messages: ["eml.title: Title is required.", "Description is required."] },
    { section: "Contacts", messages: ["At least one contact is required"] },
  ]);
});

test("parseOverview: never-published resource has no current version", () => {
  const st = parseOverview("x", `<div id="publish"><div><strong>Version 1.0</strong><span class="version-pill version-next">PENDING</span></div></div>`);
  assert.equal(st.lastPublishedVersion, undefined);
  assert.equal(st.nextVersion, "1.0");
  assert.equal(st.visibilityChangePending, false);
});

test("parseReport: running / completed / failed / unknown", () => {
  assert.equal(parseReport(`<div class="inline-spinner"></div>`).state, "running");
  assert.deepEqual(parseReport(`<div class="alert alert-success">Publishing version #1.0 finished successfully</div>`), { state: "completed", message: "Publishing version #1.0 finished successfully" });
  assert.equal(parseReport(`<div class="alert alert-danger">boom</div>`).state, "failed");
  assert.equal(parseReport(`<p>nothing</p>`).state, "unknown");
});

const mappingHtml = `
<select name="mapping.idColumn"><option value=""></option><option value="0" selected>occurrenceID</option><option value="1">name</option></select>
<div class="row mappingRow"><div class="field-label"><div class="field-label__main"><strong>Basis Of Record <span class="text-gbif-danger">*</span></strong></div><div class="field-label__original"><i>dwc:basisOfRecord</i></div></div>
  <a class="popover-link" data-bs-content="&lt;a href=&quot;http://rs.tdwg.org/dwc/terms/basisOfRecord&quot;&gt;x&lt;/a&gt;"></a>
  <select class="fidx" name="fields[16].index"><option value=""></option><option value="0">occurrenceID</option><option value="1" selected>name</option></select>
  <input name="fields[16].defaultValue" value=""></div>
<div class="row mappingRow"><div class="field-label"><div class="field-label__main"><strong>Kingdom <span class="text-gbif-danger"></span></strong></div><div class="field-label__original"><i>dwc:kingdom</i></div></div>
  <select class="fidx" name="fields[17].index"><option value="" selected></option><option value="0">occurrenceID</option><option value="1">name</option></select>
  <input name="fields[17].defaultValue" value="Plantae"></div>`;

test("parseMappingPage: columns, id column, required marker only when '*', defaults", () => {
  const p = parseMappingPage(mappingHtml);
  assert.deepEqual(p.columns, ["occurrenceID", "name"]);
  assert.equal(p.idColumn, 0);
  const [bor, kingdom] = p.fields;
  assert.equal(bor?.qualName, "dwc:basisOfRecord");
  assert.equal(bor?.uri, "http://rs.tdwg.org/dwc/terms/basisOfRecord");
  assert.equal(bor?.required, true);
  assert.equal(bor?.index, 1);
  assert.equal(kingdom?.required, false, "an empty marker span does not make a term required");
  assert.equal(kingdom?.index, undefined);
  assert.equal(kingdom?.defaultValue, "Plantae");
});

test("parseForm: inputs, selects, textareas, checkboxes, radios, controls attached by form=", () => {
  const html = `
  <form id="f" action="a.do" method="post" enctype="multipart/form-data">
    <input type="hidden" name="r" value="x"><input name="t" value="hi">
    <input type="checkbox" name="on" checked><input type="checkbox" name="off">
    <input type="radio" name="rad" value="1"><input type="radio" name="rad" value="2" checked>
    <select name="s"><option value="a">A</option><option value="b" selected>B</option></select>
    <select name="first"><option value="p">P</option><option value="q">Q</option></select>
    <textarea name="ta">
line1</textarea>
    <input type="text" name="dis" value="no" disabled><input type="submit" name="save" value="Save"><input type="file" name="f">
  </form>
  <input form="f" name="outside" value="yes">`;
  const f = parseForm(html, "form#f");
  assert.equal(f.action, "a.do");
  assert.equal(f.multipart, true);
  assert.deepEqual(f.fields, [
    { name: "r", value: "x" }, { name: "t", value: "hi" }, { name: "on", value: "on" }, { name: "rad", value: "2" },
    { name: "s", value: "b" }, { name: "first", value: "p" }, { name: "ta", value: "line1" }, { name: "outside", value: "yes" },
  ]);
  assert.throws(() => parseForm(html, "form#missing"), /form not found/);
});

test("withValues replaces existing names and appends new ones", () => {
  const out = withValues([{ name: "a", value: "1" }, { name: "b", value: "2" }], { a: "9", c: ["x", "y"] });
  assert.deepEqual(out, [{ name: "b", value: "2" }, { name: "a", value: "9" }, { name: "c", value: "x" }, { name: "c", value: "y" }]);
});

test("pageMessages collects and de-duplicates alerts", () => {
  const m = pageMessages(`<div class="alert-danger"> Bad   thing </div><div class="alert-danger">Bad thing</div><span class="field-error">Title is required.</span><div class="alert-success">Saved</div>`);
  assert.deepEqual(m.errors, ["Bad thing"]);
  assert.deepEqual(m.fieldErrors, ["Title is required."]);
  assert.deepEqual(m.success, ["Saved"]);
});

test("parseOverview: row/column counts are read in any IPT language (found on a Spanish IPT)", () => {
  const html = (t: string) => `<div id="sources"><div class="source-item"><a href="source.do?r=x&amp;id=occ">occ</a> ${t}</div></div>`;
  for (const t of ["4,4 KB | 7 rows/65 columns | 21 Sept", "4,4 KB | 7 filas/65 columnas | 21 sept", "2 MB | 1.234 lignes/12 colonnes | 3 sept"]) {
    const s = parseOverview("x", html(t)).sources[0];
    assert.deepEqual([s?.rows, s?.columns], [Number(t.match(/\| ([\d.]+)/)![1]!.replace(".", "")), Number(t.match(/\/(\d+)/)![1])], t);
  }
});
