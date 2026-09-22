# ipt-mcp

> **Experimental proof of concept.** It shows what could be done with a [GBIF IPT](https://www.gbif.org/ipt) with the
> help of an AI agent: create a resource, fill in its metadata, validate and add data, map it to Darwin Core and publish
> it, all by asking in plain language. It is not production software: expect rough edges, and try it on a test IPT first.

An MCP server that lets an AI assistant manage an IPT **from resource creation up to publication**, validating data
before it reaches the IPT.

## Setup

You need [Node.js 20 or newer](https://nodejs.org) and [git](https://git-scm.com/downloads).

**Quick way (Linux, macOS, Windows)**: the installer checks Node, installs the dependencies, saves your IPT(s) in a small
config file (without the password) and connects the server to your MCP client.

```bash
git clone https://github.com/vjrj/ipt-mcp.git
cd ipt-mcp
node scripts/install.mjs
```

It asks for a name (for example `demo`), the IPT URL, your login email and your MCP client (`claude-desktop`,
`claude-code`, or `print` to just show the configuration). Then set the password in the environment that launches the
client; the installer tells you the exact variable (for `demo`: `IPT_DEMO_PASSWORD`):

```bash
export IPT_DEMO_PASSWORD='your-password'        # Linux / macOS (Windows: setx IPT_DEMO_PASSWORD "your-password")
```

Non-interactive, and how to add more IPTs (run it again with another name):

```bash
node scripts/install.mjs --name demo --url https://ipt-demo.example.org/ipt --email me@example.org --client claude-desktop
node scripts/install.mjs --name prod --url https://ipt.example.org/ipt --email me@example.org --client claude-desktop --readonly
```

### Several IPTs (demo, production, …)

The installer writes `~/.config/ipt-mcp/instances.json` (Windows: `%APPDATA%\ipt-mcp\instances.json`); you can also edit
it by hand. `${VAR}` takes the value from an environment variable, so no password lives in the file:

```json
{
  "default": "demo",
  "instances": {
    "demo": { "url": "https://ipt-demo.example.org/ipt", "email": "me@example.org", "password": "${IPT_DEMO_PASSWORD}" },
    "prod": { "url": "https://ipt.example.org/ipt", "email": "me@example.org", "password": "${IPT_PROD_PASSWORD}", "readonly": true }
  }
}
```

Every tool accepts an `instance` argument, so you can say *"list the datasets on prod"* or *"create the resource on
demo"*; without it the `default` IPT is used. `ipt_list_instances` shows what is configured (never the credentials).
`"readonly": true` makes every write operation refuse to run on that IPT.

### Manual configuration

If you prefer to write the MCP client configuration yourself, for one IPT (no config file):

```json
{ "mcpServers": { "ipt": {
  "command": "node", "args": ["--import", "tsx", "/path/to/ipt-mcp/src/server.ts"],
  "env": { "IPT_URL": "https://my-ipt.example.org/ipt", "IPT_EMAIL": "me@example.org", "IPT_PASSWORD": "…" }
} } }
```

Or for several IPTs, pointing `IPT_INSTANCES` at the file the installer writes (see
[Several IPTs](#several-ipts-demo-production-) above) and exporting each password before launching the client:

```json
{ "mcpServers": { "ipt": {
  "command": "node", "args": ["--import", "tsx", "/path/to/ipt-mcp/src/server.ts"],
  "env": { "IPT_INSTANCES": "/home/me/.config/ipt-mcp/instances.json" }
} } }
```

```bash
export IPT_DEMO_PASSWORD='…'
export IPT_PROD_PASSWORD='…'
```

`IPT_INSTANCES` also accepts the JSON inline instead of a file path, which is handy when the client config is where you
keep environment variables too:

```json
{ "mcpServers": { "ipt": {
  "command": "node", "args": ["--import", "tsx", "/path/to/ipt-mcp/src/server.ts"],
  "env": {
    "IPT_INSTANCES": "{\"default\":\"demo\",\"instances\":{\"demo\":{\"url\":\"https://ipt-demo.example.org/ipt\",\"email\":\"me@example.org\",\"password\":\"${IPT_DEMO_PASSWORD}\"},\"prod\":{\"url\":\"https://ipt.example.org/ipt\",\"email\":\"me@example.org\",\"password\":\"${IPT_PROD_PASSWORD}\",\"readonly\":true}}}",
    "IPT_DEMO_PASSWORD": "…",
    "IPT_PROD_PASSWORD": "…"
  }
} } }
```

- Without credentials only the public queries work. `IPT_URL` defaults to `https://ipt.gbif.org`.
- `IPT_INSTANCES` (a JSON file path, or inline JSON as above) replaces `IPT_URL`/`IPT_EMAIL`/`IPT_PASSWORD` when you have several IPTs.
- `IPT_READONLY=1` makes every write operation refuse to run on all IPTs.
- Publishing, changing visibility, deleting and replacing the EML **do nothing without explicit confirmation**: the
  assistant explains what will happen (and on which IPT) and asks you first.

## What to ask (prompts by use case)

The examples assume a test IPT; replace names and paths. You can give everything in one message or go step by step.

### 1. See what is there
> Which resources can I manage on the IPT and what state is each one in (published version, visibility, valid metadata)?

> List the public datasets on my IPT that mention "plants" and tell me how many records each has.

> Which IPTs can you use? Now list the public datasets on `prod`.

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

## Security

- The password is never returned to the model: every tool result and error is scrubbed of `IPT_PASSWORD`, URL
  credentials and any field named password/secret/token/API key.
- Local files are only read or uploaded when they are real data files (`.txt .tsv .csv .xls .xlsx .zip .gz` for data,
  `.xml` for EML, `.zip` for a DwC-A) and not inside hidden paths (`~/.ssh`, `~/.config`, `~/.mcp.json`, …).
  Set `IPT_ALLOWED_DIRS=/data:/home/me/exports` to restrict them to specific directories.
- Prefer keeping passwords out of files the assistant can read: use `${VAR}` in the instances file (the installer does)
  and export the variables from your secrets manager in the environment that launches the MCP client.

Technical reference, tests and CI: [DEVELOPMENT.md](DEVELOPMENT.md).
