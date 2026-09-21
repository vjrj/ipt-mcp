# ipt-mcp

MCP server that lets an AI assistant manage a [GBIF IPT](https://www.gbif.org/ipt) **from resource creation up to
publication**, validating data before it reaches the IPT.

## Setup

```json
{ "mcpServers": { "ipt": {
  "command": "node", "args": ["--import", "tsx", "/path/to/ipt-mcp/src/server.ts"],
  "env": { "IPT_URL": "https://my-ipt.example.org/ipt", "IPT_EMAIL": "me@example.org", "IPT_PASSWORD": "…" }
} } }
```

- Without credentials only the public queries work. `IPT_URL` defaults to `https://ipt.gbif.org`.
- `IPT_READONLY=1` makes every write operation refuse to run.
- Publishing, changing visibility, deleting and replacing the EML **do nothing without explicit confirmation**: the
  assistant explains what will happen and asks you first.

## Security

- The password is never returned to the model: every tool result and error is scrubbed of `IPT_PASSWORD`, URL
  credentials and any field named password/secret/token/API key.
- Local files are only read or uploaded when they are real data files (`.txt .tsv .csv .xls .xlsx .zip .gz` for data,
  `.xml` for EML, `.zip` for a DwC-A) and not inside hidden paths (`~/.ssh`, `~/.config`, `~/.mcp.json`, …).
  Set `IPT_ALLOWED_DIRS=/data:/home/me/exports` to restrict them to specific directories.
- Prefer keeping the password out of files the assistant can read (for example a secrets manager exporting
  `IPT_PASSWORD` in the environment that launches the MCP client).

## What to ask (prompts by use case)

The examples assume a test IPT; replace names and paths. You can give everything in one message or go step by step.

### 1. See what is there
> Which resources can I manage on the IPT and what state is each one in (published version, visibility, valid metadata)?

> List the public datasets on my IPT that mention "plants" and tell me how many records each has.

### 2. Create a resource from scratch
> Create an occurrence resource with shortname `flora_valencia_2025`.

> Create a checklist resource called `bryophyte_catalogue`.

### 3. Create a resource from an existing DwC-A
> Create the resource `herbarium_uv` by importing `/data/herbarium_uv.zip`, and tell me whether it is ready to publish.

### 4. Fill in the metadata
> In `flora_valencia_2025` set the title "Vascular flora of the province of Valencia", language Spanish, licence CC0 and
> this description: "…". Contact, creator and metadata provider: Ana Perez, Valencia Botanical Garden, ana@example.org.

> Add geographic coverage (lat 38–40, lon −1 to 0.5, "Province of Valencia"), temporal coverage from 2019-01-01 to
> 2023-12-31 and taxonomic coverage for *Quercus ilex* and *Pinus halepensis*.

> Add the keywords "flora" and "Valencian Community" and these methods: study extent "province of Valencia", sampling
> "random transects", quality control "manual review by a botanist".

> Replace the resource metadata with the contents of this EML file: `/data/revised_eml.xml`.

> Show me the fields of the project section and fill in the title and funding with …

### 5. Add the data (with validation)
> Validate `/data/occurrences.txt` before uploading it and tell me what problems it has.

> Upload `/data/occurrences.txt` as a source of `flora_valencia_2025`. If it has problems, do not upload it and explain them.

> Add the URL `https://example.org/export.csv` as a source named `export`, comma delimiter, UTF-8, and show me the first
> rows as the IPT understands them.

> My large file has records split by line breaks: tell me how many rows are broken and on which lines.

### 6. Map to Darwin Core
> Map the source `occurrences` to Darwin Core Occurrence and tell me which columns were left unmapped.

> In the Occurrence mapping, assign `obs_date` to `eventDate` and `sp` to `scientificName`, and set `kingdom` = Plantae
> and `basisOfRecord` = HumanObservation as fixed values.

> Show me the current mapping and which required terms are missing.

### 7. Check before publishing
> Check whether `flora_valencia_2025` is ready to publish and tell me everything that is missing, section by section.

### 8. Publish
> Publish `flora_valencia_2025` with the summary "First version" and tell me when it finishes, how many records were
> generated and whether there were warnings.

> Publish only the metadata of `bryophyte_catalogue` (no data).

### 9. Make it public
> Make `flora_valencia_2025` public and publish a new version so the change takes effect. Then check that it appears in
> the public list with its record count.

### 10. Update a version
> I changed `/data/occurrences.txt`. Validate it, upload it again as the source `occurrences`, re-analyse it, check that
> the mapping is still complete and publish the next version.

### 11. Automatic publication
> Configure `flora_valencia_2025` to publish automatically every Friday at 12:00.

### 12. Diagnosis and clean-up
> The last publication of `flora_valencia_2025` failed: show me its status and the end of the log.

> Delete the source `test` and the resource `draft_test`.

### The whole flow in one message
> Using `/data/occurrences.txt`, create an occurrence resource `flora_valencia_2025`. Title "…", description "…",
> licence CC-BY, contact and creator Ana Perez (Botanical Garden, ana@example.org). Validate and upload the file, map it
> to Occurrence, check that it is ready and, if it is, tell me which version will be created and ask me to confirm
> before publishing.

## Tips

- Always ask to **"validate first"** when working with new files: the assistant uses `validate_tsv` and will not upload broken data.
- If something fails, the error includes the IPT's own message; ask the assistant to fix it and retry.
- For actions that need confirmation, answer "yes, go ahead" once it has described what it is going to do.

Technical reference, tests and CI: [DEVELOPMENT.md](DEVELOPMENT.md).
