# Intent V2

Keep a root `project.intent` beside the source code to describe the system you want. Intent V2 provides offline language editing in VS Code. The agent skill handles translating intent into code, design linting, discussion, and acceptance.

## Install

Build and package with Bun, then install the VSIX in VS Code.

```sh
bun install --frozen-lockfile
bun run package
code --install-extension intent-v2-2.0.0.vsix
```

For Codex, copy `skills/intent` into your user skills directory. From this checkout:

```sh
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R skills/intent "${CODEX_HOME:-$HOME/.codex}/skills/"
```

## Develop

```sh
bun run check
bun run build
bun test
```

The bundled extension and stdio server run on VS Code's Node runtime. Tests also use Node to exercise the packaged server transport.

See [language syntax](LANGUAGE.md) and [this project's intent](project.intent).
