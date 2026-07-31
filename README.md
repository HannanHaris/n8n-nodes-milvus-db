# n8n-nodes-milvus-db

A fork of n8n's built-in **Milvus Vector Store** node that adds an explicit
**Database** selector. The collection dropdown is scoped to the selected database.

Upstream n8n has no database option — the connection always lands in Milvus's
`default` db. The feature request was closed as not planned; a community PR has
been open and unmerged since 2025 (currently n8n-io/n8n#28082).

## What's different from the built-in node

| | Built-in `vectorStoreMilvus` | This node `vectorStoreMilvusDb` |
|---|---|---|
| Database | always `default` | dropdown, listed from `listDatabases()` |
| Collection | all collections in `default` | scoped to the selected database |
| Credential | `milvusApi` | `milvusApi` (**the same one** — no re-entry) |
| Modes | load / insert / retrieve / retrieve-as-tool | identical |

It reuses the existing `milvusApi` credential type, so your current Milvus
credentials appear in the dropdown untouched. Both nodes can coexist — existing
workflows on the built-in node keep working.

## How the database actually gets applied

LangChain's `Milvus` constructor spreads `clientConfig` first, then overrides
`address` / `username` / `password` from the top-level args. So `database` set
inside `clientConfig` survives and pins the gRPC connection to that db. Every
subsequent call (`listCollections`, search, insert) is scoped by it.

## Build

```bash
npm install
npm run build     # -> dist/nodes/VectorStoreMilvusDb/
```

## Local development

```bash
mkdir -p ~/.n8n/custom && cd ~/.n8n/custom && npm init -y
cd /path/to/this/repo && npm link
cd ~/.n8n/custom && npm link n8n-nodes-milvus-db
n8n start
```

Search the nodes panel for **Milvus Vector Store (DB)** — search the *node*
name, not the package name.

## Deploy to Kubernetes / ACK

```bash
docker build --build-arg N8N_VERSION=<your n8n version> \
  -t <your-acr>/n8n-milvus:0.1.0 .
docker push <your-acr>/n8n-milvus:0.1.0
```

Then point the deployment at the new image. Nothing else to configure —
`N8N_CUSTOM_EXTENSIONS` is baked in.

### Two things that will bite you

**1. PVC shadowing.** If you mount a volume at `/home/node/.n8n`, anything you
copied to `~/.n8n/custom` at build time is hidden by the mount and the node
silently won't appear. That's why this image uses `/opt/n8n-milvus/custom`,
outside any volume.

**2. node_modules inside the custom directory.** n8n's `CustomDirectoryLoader`
globs `**/*.node.js` under each custom dir and loads every match — it does not
read `package.json`. Dependencies contain at least one file matching that
pattern (`brotli-wasm/index.node.js`). Keeping `node_modules` one level above
the custom dir sidesteps it while still resolving normally.

### Optional: shrink the image

The bundled dependency tree is ~560 MB, mostly `@langchain/community`. The n8n
image already ships `@langchain/community`, `@langchain/core`,
`@zilliz/milvus2-sdk-node` and `@n8n/ai-utilities`. Confirm the path:

```bash
docker run --rm --entrypoint sh n8nio/n8n:<version> -c \
  'ls -d /usr/local/lib/node_modules/n8n/node_modules/@n8n/ai-utilities'
```

If it's there, you can drop the `COPY --from=builder /build/node_modules` line
and instead set:

```dockerfile
ENV NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules
```

This also removes the duplicate-LangChain-instance risk (two copies of
`@langchain/core` in one process). Test insert *and* retrieve before shipping —
if document objects cross the boundary and something does an `instanceof` check,
this is where it would surface.

## Version pinning

`@n8n/ai-utilities` and `n8n-workflow` must match the versions your n8n runs.
Mismatched `n8n-workflow` copies produce confusing TypeScript structural errors
at build time. Check with:

```bash
docker run --rm --entrypoint sh n8nio/n8n:<version> -c \
  'cat /usr/local/lib/node_modules/n8n/node_modules/@n8n/ai-utilities/package.json | grep version'
```

Currently pinned: `@n8n/ai-utilities@0.24.3`, `n8n-workflow@2.31.3`,
`@langchain/community@1.1.27`, `@langchain/core@1.2.0`.

## Permissions

Listing databases requires the credential's Milvus user to have database-level
read privileges. If it doesn't, the dropdown falls back to offering `default`
only — you can still type a database name using the **By Name** mode.

## Icon

`milvusdb.svg` is a generic placeholder. Swap in your own if you want the real
Milvus mark; check its trademark terms before redistributing it.
