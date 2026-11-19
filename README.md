# Intent

Intent is an experiment in maintaining a project with a short, declarative description of how it should work. Keep a `project.intent` file beside the code. Write down the behavior and decisions you want to preserve as the project changes.

When you want the system to work differently, change the description and use it to guide the code change. When a decision comes up while working in code, bring it back into the description. The idea is to make the next change easier to reason about without piecing together old prompts and diffs.

The VS Code extension adds highlighting, completion, and navigation for [Intent files](LANGUAGE.md). The [agent skill](skills/intent/SKILL.md) explains how to keep the description and code in sync.

## Install the extension

Download the VSIX from the release you want under **Releases** on GitHub. In VS Code, open the Command Palette, choose **Extensions: Install from VSIX…**, and select the download.

## Install the skill

From a checkout of this repo, copy the skill into your Codex skills directory.

```sh
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R skills/intent "${CODEX_HOME:-$HOME/.codex}/skills/"
```

## Build and test

Use Bun and Node.js to build, test, and package the extension.

```sh
bun install --frozen-lockfile
bun run check
bun run build
bun test
bun run package
```

GitHub Actions packages the extension and attaches the VSIX to a GitHub release when you push a version tag. The version comes from the tag, with or without a leading `v`.
