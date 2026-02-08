# Build Guide

## Prerequisites

- Node.js >= 18
- pnpm (`corepack enable`)
- Bun (for relay binary build)

## Install Dependencies

```bash
pnpm install
```

## Build Commands

From the workspace root:

```bash
# Build everything (extension + relay)
pnpm build --allow-missing-repository

# Extension only
pnpm build:extension

# Relay (transpile with tsc, for npm publishing)
pnpm build:relay

# Relay standalone binary (no Node.js required to run)
pnpm build:relay:bin

# Package extension as .vsix for local install
pnpm package:extension
```

## Output

| Target | Output | Description |
|--------|--------|-------------|
| Extension | `packages/extension/dist/extension.js` | VSCode extension bundle |
| Relay (tsc) | `packages/relay/dist/index.js` | Node.js entrypoint |
| Relay (bin) | `packages/relay/dist/vscode-as-mcp-server` | Standalone binary |
| Extension (.vsix) | `packages/extension/*.vsix` | Local installable extension |

## Installing the .vsix Locally

```bash
code --install-extension packages/extension/vscode-as-mcp-server-0.0.25.vsix
```

Or in VSCode: Extensions panel > `...` menu > "Install from VSIX..."

## Running the Relay Binary

```bash
./packages/relay/dist/vscode-as-mcp-server [--server-url http://localhost:60100]
```

## Development

```bash
# Watch mode for extension (rebuilds on file changes)
cd packages/extension && pnpm watch

# Dev mode for relay (runs with tsx)
cd packages/relay && pnpm dev
```
