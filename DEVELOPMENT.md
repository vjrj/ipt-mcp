# Development

## What this is, and what it should become

This is a proof of concept and it is built the only way the IPT allows today: **it drives the IPT web UI**. The IPT has
no management API, so the server logs in like a browser, reads each form, posts it back and scrapes the answers. That
is brittle by nature (a form change in a new IPT release can break it; the nightly CI job exists to notice that) and it
works around behaviour that an API would make explicit. A proper solution would add a documented management API to
the IPT itself (resources, metadata, sources, mappings, publication, with token authentication) and make the MCP a thin
wrapper over it; the code here would then shrink to tool definitions and the data validation.

## Checks the IPT does not do (found by testing against a real IPT)

- The IPT **publishes resources with invalid metadata or no data** (as a "metadata-only" version), and a failed
  publish consumes a version number. `ipt_publish` runs `ipt_validate_resource` first and refuses when there are problems.
- A second mapping of the same row type publishes every record twice; `ipt_add_mapping` rejects it.
- Files with embedded newlines or tabs break source analysis; `ipt_add_source` runs `validate_tsv` (streaming) and
  rejects them.
- Making a resource public only takes effect with the next publication.
- Making a resource private is the same kind of change (it applies with the next publication). The IPT answers a
  request for the state the resource already has with an "invalid change" warning on the redirected page;
  `ipt_set_visibility` reports it instead of pretending it worked. The make-private form must carry `unpublish=Change`.
- IPT 3.3.0 silently ignores the delimiter and quote fields of an existing file source (it detects them on upload), so
  `ipt_configure_source` verifies a requested delimiter against the file and fails with a clear message if it was not
  applied. Header lines, encoding and date format are applied.
- Re-saving a URL source's settings must not post its (never displayed) delimiter back empty: the client leaves those
  fields out unless asked to change them.
- To replace a file source, upload a file with the same file name (the source is named after it).
- `peek.do` (the source preview) can briefly lag right after `source.do` reports a source re-analysed: the row/column
  counts are already current but the preview still shows the previous (or an anonymous "Column #N") header for a
  moment. Caught once by the nightly job against the newest IPT release; the affected test retries (`until` in
  `test/integration/helpers.ts`). `ipt_peek_source` itself is a plain, single read — an agent hitting this should
  just ask again.
- The IPT has no web action to reload the data directory: `resources/<r>/datapackage.json` (and `resource.xml`) are
  read only at startup, and every save rewrites them from memory, so hand edits on disk are lost while it runs.
  `ipt_get_datapackage_metadata` reads the draft where the IPT shows it (`#json-raw-data` on the overview, ColDP only)
  and otherwise the last published version (`/metadata.do`); and
  `ipt_replace_datapackage_metadata` posts to `replace-datapackage-metadata.do`, which resets `name`/`id`/`created`,
  keeps the version and drops unknown properties; when the draft is readable the tool lists the dropped paths.
  `ipt_cancel_publication` (`cancel.do`) unlocks a stuck publication without a restart.
- When the session expires, the client logs in again transparently.

## How it works

The IPT has no management API (only read-only public JSON: `/api/*`, `/inventory/v2/dataset`). Manager operations use
the same session and forms as the web UI (login with CSRF token + POST to `/manage/*.do`), reading each form before
submitting it so nothing depends on hard-coded parameter names.

## Tests

```bash
npm test                      # unit tests: parsers, fake-IPT flows, validators, config/installer, MCP protocol over stdio
npm run test:integration      # needs a disposable IPT (below)
```

The integration tests run the whole flow (create → metadata → source → mapping → validate → publish → public →
delete, checklist core, URL source, DwC-A import, EML replace, auto-publish, expired session), both directly and
through the MCP protocol. `test/integration/cov-*.test.ts` follow the README prompts one by one (search, create from a
DwC-A, every metadata section, encoding/URL/large-file sources, column mapping, publish/metadata-only/public/update
version/auto-publish/failed publication/delete), so each thing the README promises has a test that proves it:

```bash
harness/fetch-war.sh 3.3.0 ipt.war          # official release from repository.gbif.org
IPT_WAR=$PWD/ipt.war harness/start-ipt.sh   # official Tomcat image, throw-away data, port 18080
harness/setup-ipt.sh                        # installation wizard in TEST mode (never touches the GBIF registry)
IPT_TEST_URL=http://localhost:18080/ipt npm run test:integration
```

CI (`.github/workflows/ci.yml`) runs the unit tests on Node 20/22 and the integration suite against IPT 3.3.0 and the
newest release (nightly), which flags form changes that would break the driver.

## Not covered yet

GBIF registration, DOIs, user and organisation administration, vocabulary value translations, data-package (Camtrap DP)
resources beyond importing a package and reading/replacing its metadata, and SQL sources against a live database
(implemented but not integration-tested).
