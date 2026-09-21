# Development

## Checks the IPT does not do (found by testing against a real IPT)

- The IPT **publishes resources with invalid metadata or no data** (as a "metadata-only" version), and a failed
  publish consumes a version number. `ipt_publish` runs `ipt_validate_resource` first and refuses when there are problems.
- A second mapping of the same row type publishes every record twice; `ipt_add_mapping` rejects it.
- Files with embedded newlines or tabs break source analysis; `ipt_add_source` runs `validate_tsv` (streaming) and
  rejects them.
- Making a resource public only takes effect with the next publication.
- When the session expires, the client logs in again transparently.

## How it works

The IPT has no management API (only read-only public JSON: `/api/*`, `/inventory/v2/dataset`). Manager operations use
the same session and forms as the web UI (login with CSRF token + POST to `/manage/*.do`), reading each form before
submitting it so nothing depends on hard-coded parameter names.

## Tests

```bash
npm test                      # 29 unit tests: parsers, fake-IPT flows, validators, MCP protocol over stdio
npm run test:integration      # needs a disposable IPT (below)
```

The integration tests run the whole flow (create → metadata → source → mapping → validate → publish → public →
delete, checklist core, URL source, DwC-A import, EML replace, auto-publish, expired session), both directly and
through the MCP protocol:

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
resources, and SQL sources against a live database (implemented but not integration-tested).
