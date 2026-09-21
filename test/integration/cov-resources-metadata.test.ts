import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ADA, OCC, TAXON, addAndMap, archiveFile, cleanup, connect, draftEml, fx, makePublic, newResource, publishAndWait, skip, tmp, uniq, write } from "./helpers.ts";

// README prompts 1-4: see what is there, create (from scratch / checklist / DwC-A), fill in the metadata.

test("prompt 1 — see what is there", { skip, timeout: 300_000 }, async (t) => {
  const { client, call } = await connect();
  const created: string[] = [];
  try {
    const inTitle = await newResource(call, "plt", { title: "Plants of the Valencian coast", description: "Dataset about coastal vegetation with invented records for testing." });
    const inAbstract = await newResource(call, "abs", { title: "Vascular flora survey", description: "A survey of the flora that also mentions plants growing on dunes, with invented records." });
    const unrelated = await newResource(call, "unr", { title: "Beetle collection", description: "A collection of beetles with invented records used for testing." });
    created.push(inTitle, inAbstract, unrelated);
    for (const sn of [inTitle, inAbstract, unrelated]) {
      await addAndMap(call, sn, fx("occurrences.txt"));
      await makePublic(call, sn);
    }

    await t.test("managed resources: every one, as structured rows with visibility", async () => {
      const r = await call("ipt_list_managed_resources");
      assert.equal(r.isError, false, r.body);
      const mine = r.json.filter((x: any) => created.includes(x.shortname));
      assert.equal(mine.length, 3);
      assert.ok(mine.every((x: any) => x.title && Array.isArray(x.cells)));
      assert.ok(mine.every((x: any) => x.cells.some((c: string) => /public/i.test(c))), JSON.stringify(mine[0]));
    });

    await t.test("status of one resource: version, visibility, metadata validity", async () => {
      const r = await call("ipt_get_status", { shortname: inTitle });
      assert.equal(r.json.lastPublishedVersion, "1.0");
      assert.equal(r.json.visibility, "public");
      assert.deepEqual(r.json.metadataProblems, []);
      assert.match(r.json.metadata, /\bValid\b/);
    });

    await t.test("'datasets that mention plants' finds the abstract match only when asked to look there", async () => {
      const titleOnly = await call("ipt_list_datasets", { query: "plants" });
      const ids = titleOnly.json.datasets.map((d: any) => d.id);
      assert.ok(ids.includes(inTitle));
      assert.ok(!ids.includes(inAbstract), "abstract-only match must not appear without searchMetadata");

      const deep = await call("ipt_list_datasets", { query: "plants", searchMetadata: true });
      const by = Object.fromEntries(deep.json.datasets.map((d: any) => [d.id, d]));
      assert.equal(by[inTitle]?.matchedIn, "id/title");
      assert.equal(by[inAbstract]?.matchedIn, "abstract");
      assert.equal(by[unrelated], undefined);
      assert.equal(by[inTitle]?.records, 5, "record counts are reported");
      assert.equal(by[inAbstract]?.records, 5);
      assert.equal(deep.json.matched, deep.json.datasets.length);

      const none = await call("ipt_list_datasets", { query: "zzz-no-such-thing", searchMetadata: true });
      assert.equal(none.json.matched, 0);
    });
  } finally {
    await cleanup(call, ...created);
    await client.close();
  }
});

test("prompts 2 and 3 — create from scratch, as a checklist, and from an existing DwC-A", { skip, timeout: 300_000 }, async (t) => {
  const { client, call } = await connect();
  const created: string[] = [];
  try {
    await t.test("checklist through the protocol: Taxon core mapped, validated and published", async () => {
      const sn = await newResource(call, "chk", { type: "checklist" });
      created.push(sn);
      const { source } = await addAndMap(call, sn, fx("taxa.txt"), TAXON);
      assert.equal(source, "taxa");
      const v = await call("ipt_validate_resource", { shortname: sn });
      assert.deepEqual(v.json.problems, []);
      const p = await publishAndWait(call, sn);
      assert.equal(p.json.state, "completed", p.body);
      const log = await call("ipt_get_publication_status", { shortname: sn });
      assert.match(log.json.log, /3 records/);
    });

    await t.test("import a DwC-A with the create tool: source, mapping and metadata come along", async () => {
      const sn = uniq("imp");
      created.push(sn);
      const r = await call("ipt_create_resource", { shortname: sn, type: "occurrence", dwcaPath: fx("sample-dwca.zip") });
      assert.equal(r.isError, false, r.body);
      const st = await call("ipt_get_status", { shortname: sn });
      assert.equal(st.json.sources.length, 1);
      assert.equal(st.json.sources[0].rows, 5);
      assert.equal(st.json.mappings.length, 1);
      const v = await call("ipt_validate_resource", { shortname: sn });
      assert.equal(v.json.ready, true, v.body);
    });

    await t.test("DwC-A import refuses hidden directories, non-zip files and missing files", async () => {
      const dir = tmp();
      mkdirSync(join(dir, ".hidden"));
      copyFileSync(fx("sample-dwca.zip"), join(dir, ".hidden", "a.zip"));
      const hidden = await call("ipt_create_resource", { shortname: uniq("bad"), type: "occurrence", dwcaPath: join(dir, ".hidden", "a.zip") });
      assert.equal(hidden.isError, true);
      assert.match(hidden.body, /hidden path/);
      const notZip = await call("ipt_create_resource", { shortname: uniq("bad"), type: "occurrence", dwcaPath: fx("occurrences.txt") });
      assert.equal(notZip.isError, true);
      assert.match(notZip.body, /unsupported file type/);
      const missing = await call("ipt_create_resource", { shortname: uniq("bad"), type: "occurrence", dwcaPath: join(dir, "nope.zip") });
      assert.match(missing.body, /not found/);
    });

    await t.test("creating a duplicate shortname, or an invalid one, fails clearly", async () => {
      const sn = await newResource(call, "dup");
      created.push(sn);
      assert.equal((await call("ipt_create_resource", { shortname: sn, type: "occurrence" })).isError, true);
      const bad = await call("ipt_create_resource", { shortname: "has space", type: "occurrence" }).catch((e) => ({ isError: true, body: String(e) }));
      assert.equal(bad.isError, true);
    });
  } finally {
    await cleanup(call, ...created);
    await client.close();
  }
});

test("prompt 4 — the metadata really ends up in the EML", { skip, timeout: 300_000 }, async (t) => {
  const { client, call } = await connect();
  const sn = await newResource(call, "meta");
  try {
    await t.test("basic metadata: title, language, licence, update frequency", async () => {
      const r = await call("ipt_set_basic_metadata", {
        shortname: sn,
        title: "Vascular flora of the province of Valencia",
        language: "spa",
        license: "ccby",
        updateFrequency: "monthly",
        description: "Vascular flora records of the province of Valencia collected between 2019 and 2023, invented for testing purposes only.",
      });
      assert.equal(r.isError, false, r.body);
      const eml = await draftEml(call, sn);
      assert.match(eml, /<title[^>]*>Vascular flora of the province of Valencia<\/title>/);
      assert.match(eml, /<language>spa<\/language>/);
      assert.match(eml, /Creative Commons Attribution \(CC-BY\)|CC-BY/i);
      assert.match(eml, /monthly/);
      assert.match(eml, /invented for testing purposes only/);
    });

    await t.test("a full agent: position, address, country, phone, email, homepage and ORCID reach the EML", async () => {
      const full = {
        firstName: "Ana", lastName: "Perez", organisation: "Valencia Botanical Garden", position: "Curator",
        address: "Calle Quart 80", city: "Valencia", province: "Valencia", postalCode: "46008", country: "ES",
        phone: "+34 963 315 000", email: "ana@example.org", homepage: "https://example.org/ana",
        userIdDirectory: "https://orcid.org/", userId: "0000-0002-1825-0097",
      };
      const r = await call("ipt_set_contacts", { shortname: sn, contacts: [full], creators: [full], metadataProviders: [full] });
      assert.equal(r.isError, false, r.body);
      const eml = await draftEml(call, sn);
      for (const re of [/<givenName>Ana<\/givenName>/, /<surName>Perez<\/surName>/, /<organizationName>Valencia Botanical Garden<\/organizationName>/, /<positionName>Curator<\/positionName>/, /<city>Valencia<\/city>/, /<postalCode>46008<\/postalCode>/, /<country>ES<\/country>/, /<phone[^>]*>\+34 963 315 000<\/phone>/, /<electronicMailAddress>ana@example.org<\/electronicMailAddress>/, /<onlineUrl>https:\/\/example.org\/ana<\/onlineUrl>/, /<userId directory="https:\/\/orcid.org\/">0000-0002-1825-0097<\/userId>/]) {
        assert.match(eml, re);
      }
    });

    await t.test("associated party with a role, added without touching contacts and creators", async () => {
      const r = await call("ipt_set_contacts", { shortname: sn, associatedParties: [{ firstName: "Luis", lastName: "Gil", organisation: "Herbarium UV", role: "editor" }] });
      assert.equal(r.isError, false, r.body);
      const eml = await draftEml(call, sn);
      assert.match(eml, /<associatedParty>[\s\S]*<surName>Gil<\/surName>[\s\S]*<role>editor<\/role>/);
      assert.match(eml, /<surName>Perez<\/surName>/, "existing contacts are kept");
    });

    await t.test("geographic, temporal and taxonomic coverage, keywords and methods", async () => {
      const cov = await call("ipt_set_coverage", {
        shortname: sn,
        geographic: [{ description: "Province of Valencia", minLatitude: 38, maxLatitude: 40, minLongitude: -1, maxLongitude: 0.5 }],
        temporal: [{ startDate: "2019-01-01", endDate: "2023-12-31" }],
        taxonomic: [{ description: "Vascular plants", taxa: [{ scientificName: "Quercus ilex", commonName: "Holm oak", rank: "species" }, { scientificName: "Pinus halepensis" }] }],
      });
      assert.equal(cov.isError, false, cov.body);
      const kw = await call("ipt_set_keywords_methods", {
        shortname: sn,
        keywords: [{ thesaurus: "GBIF Dataset Type Vocabulary", keywords: ["flora", "Valencian Community"] }],
        methods: { studyExtent: "province of Valencia", sampleDescription: "random transects", qualityControl: "manual review by a botanist", steps: ["Field survey", "Data entry"] },
      });
      assert.equal(kw.isError, false, kw.body);
      const eml = await draftEml(call, sn);
      for (const re of [/<geographicDescription>Province of Valencia<\/geographicDescription>/, /<westBoundingCoordinate>-1(\.0)?<\/westBoundingCoordinate>/, /<eastBoundingCoordinate>0\.5<\/eastBoundingCoordinate>/, /<beginDate>\s*<calendarDate>2019-01-01/, /<endDate>\s*<calendarDate>2023-12-31/, /<taxonRankValue>Quercus ilex<\/taxonRankValue>/, /<commonName>Holm oak<\/commonName>/, /<keyword>flora<\/keyword>/, /<keyword>Valencian Community<\/keyword>/, /<studyExtent>[\s\S]*province of Valencia/, /<samplingDescription>[\s\S]*random transects/, /<qualityControl>[\s\S]*manual review by a botanist/, /<methodStep>[\s\S]*Field survey[\s\S]*<methodStep>[\s\S]*Data entry/]) {
        assert.match(eml, re);
      }
    });

    await t.test("'show me the project section and fill it in': the generic form tools", async () => {
      const form = await call("ipt_get_metadata_form", { shortname: sn, section: "project" });
      assert.equal(form.isError, false, form.body);
      const names = form.json.map((f: any) => f.name);
      assert.ok(names.includes("eml.project.title") && names.includes("eml.project.funding"), names.join());
      const set = await call("ipt_set_metadata_fields", {
        shortname: sn, section: "project",
        fields: {
          "eml.project.title": "Flora Valentina", "eml.project.funding": "Generalitat Valenciana grant 123", "eml.project.identifier": "FV-2025",
          "eml.project.personnel[0].firstName": "Ana", "eml.project.personnel[0].lastName": "Perez", "eml.project.personnel[0].role": "principalInvestigator",
        },
      });
      assert.equal(set.isError, false, set.body);
      const eml = await draftEml(call, sn);
      assert.match(eml, /<project[^>]*>[\s\S]*<title>Flora Valentina<\/title>/);
      assert.match(eml, /<funding>[\s\S]*Generalitat Valenciana grant 123/);
      assert.match(eml, /<personnel>[\s\S]*<surName>Perez<\/surName>[\s\S]*<role>principalInvestigator<\/role>/);
    });

    await t.test("a mistyped field name is reported, not silently ignored", async () => {
      const r = await call("ipt_set_metadata_fields", { shortname: sn, section: "project", fields: { "eml.project.titel": "typo", "eml.project.personnel[0].firstName": "Ana", "eml.project.personnel[0].lastName": "Perez" } });
      assert.equal(r.isError, true);
      assert.match(r.body, /did not store: eml\.project\.titel/);
      assert.match(r.body, /eml\.project\.title/, "the valid field names are listed");
    });

    await t.test("other sections through the generic tool: additional information", async () => {
      const r = await call("ipt_set_metadata_fields", { shortname: sn, section: "additional", fields: { "eml.additionalInfo": "Records were curated in 2025." } });
      assert.equal(r.isError, false, r.body);
      assert.match(await draftEml(call, sn), /<additionalInfo>[\s\S]*Records were curated in 2025\./);
    });

    await t.test("invalid values are refused with the IPT's message and nothing is half-saved", async () => {
      const before = await draftEml(call, sn);
      const noSampling = await call("ipt_set_keywords_methods", { shortname: sn, methods: { studyExtent: "x", sampleDescription: "", steps: ["s"] } });
      assert.equal(noSampling.isError, true);
      assert.match(noSampling.body, /Sampling Description is required/);
      const badCoverage = await call("ipt_set_coverage", { shortname: sn, geographic: [{ minLatitude: 10, maxLatitude: 5, minLongitude: 0, maxLongitude: 1 }] });
      assert.equal(badCoverage.isError, true);
      assert.match(badCoverage.body, /minLatitude > maxLatitude/);
      const badDate = await call("ipt_set_coverage", { shortname: sn, temporal: [{ startDate: "2020/01/01" }] });
      assert.match(badDate.body, /yyyy-mm-dd/);
      assert.equal(await draftEml(call, sn), before, "EML unchanged by the rejected calls");
    });

    await t.test("replace the EML: needs confirmation, then replaces; junk and hidden files are refused", async () => {
      const dir = tmp();
      // A real, valid EML (the IPT rejects its own unpublished drafts because of the empty pubDate).
      const zip = fx("sample-dwca.zip");
      const newEml = execFileSync("unzip", ["-p", zip, "eml.xml"], { encoding: "utf8" }).replace(/<title[^>]*>[^<]*<\/title>/, "<title>Replaced by uploaded EML</title>");
      const good = write(dir, "revised_eml.xml", newEml);
      const ask = await call("ipt_replace_eml", { shortname: sn, path: good });
      assert.equal(ask.json.needsConfirmation, true);
      assert.doesNotMatch(await draftEml(call, sn), /Replaced by uploaded EML/, "nothing happens without confirm");

      const done = await call("ipt_replace_eml", { shortname: sn, path: good, confirm: true });
      assert.equal(done.isError, false, done.body);
      assert.match(await draftEml(call, sn), /Replaced by uploaded EML/);

      const junk = await call("ipt_replace_eml", { shortname: sn, path: write(dir, "junk.xml", "this is not EML"), confirm: true });
      assert.equal(junk.isError, true);
      mkdirSync(join(dir, ".secret"));
      const hidden = await call("ipt_replace_eml", { shortname: sn, path: write(join(dir, ".secret"), "e.xml", newEml), confirm: true });
      assert.match(hidden.body, /hidden path/);
      const wrongType = await call("ipt_replace_eml", { shortname: sn, path: fx("occurrences.txt"), confirm: true });
      assert.match(wrongType.body, /unsupported file type/);
    });
  } finally {
    await cleanup(call, sn);
    await client.close();
  }
});
