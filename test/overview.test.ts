import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMappingPage, parseOverview } from "../src/overview.ts";

const withVisibility = (badge: string, text: string) =>
  parseOverview("x", `<div id="visibility"><span class="badge">${badge}</span><p>${text}</p></div>`);

test("parseOverview: visibility is normalised, and the IPT's own wording is kept", () => {
  const s = withVisibility("Public", "This resource is public.");
  assert.equal(s.visibility, "public");
  assert.match(s.visibilityText, /This resource is public/);
  assert.equal(withVisibility("Private", "").visibility, "private");
  assert.equal(withVisibility("Registered", "").visibility, "registered");
});

test("parseOverview: unrecognised badge falls back to the sentence, then to 'unknown'", () => {
  assert.equal(withVisibility("Público", "This resource is private to managers").visibility, "private");
  assert.equal(withVisibility("Público", "El recurso es public").visibility, "public");
  assert.equal(withVisibility("Público", "nothing useful here").visibility, "unknown");
  assert.equal(withVisibility("Deleted", "").visibility, "deleted");
  assert.equal(withVisibility("", "Deleted but public").visibility, "deleted");
});

test("parseMappingPage: a vocabulary term's default comes from the selected <option>, not the option texts", () => {
  const html = `
  <div class="row mappingRow"><div class="field-label__original"><i>dwc:basisOfRecord</i></div>
    <select class="fidx" name="fields[0].index"><option value="" selected></option><option value="0">c</option></select>
    <select name="fields[0].defaultValue"><option value=""></option><option value="HumanObservation" selected>Human observation</option><option value="PreservedSpecimen">Preserved</option></select></div>
  <div class="row mappingRow"><div class="field-label__original"><i>dwc:kingdom</i></div>
    <select class="fidx" name="fields[1].index"><option value="" selected></option><option value="0">c</option></select>
    <select name="fields[1].defaultValue"><option value="" selected></option><option value="A">A</option></select></div>`;
  const [bor, kingdom] = parseMappingPage(html).fields;
  assert.equal(bor?.defaultValue, "HumanObservation");
  assert.equal(kingdom?.defaultValue, "");
});
