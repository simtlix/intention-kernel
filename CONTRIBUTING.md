# Contributing

Intention Kernel welcomes reproducible bug reports, documentation improvements, and focused pull requests. Discuss changes to the public API or execution semantics in an issue before starting a large implementation.

## Local development

Clone the source repository and use Node.js 22 with npm 10. The package is ESM-only.

```sh
git clone https://github.com/simtlix/intention-kernel.git
cd intention-kernel
npm ci
npm run verify
npm run docs:dev
```

`verify` checks types, lint, behavior, documentation, and installation into a clean consumer from the packed tarball. The automated checks do not require model-provider credentials. Live demos are optional and documented in the [example guide](https://simtlix.github.io/intention-kernel/development/examples.html).

## Repository layout

| Directory | Purpose |
| --- | --- |
| `src/` | Library implementation, including the public `testing` entry point. |
| `tests/` | Behavior, type, and installed-package checks. |
| `examples/` | Executable applications and evaluation examples. |
| `docs/` | Documentation site, generated API reference, and public visual assets. |
| `api-reports/` | Generated API signatures tracked to review public contract changes. |
| `config/` | API Extractor configuration for the runtime and testing entry points. |
| `scripts/` | Build, documentation, package verification, release, and visual-asset automation. |
| `.github/` | CI, GitHub Pages deployment, release workflows, and contribution templates. |

Repository scripts are versioned so contributors and CI can run the same commands
from a fresh clone. The package's `files` allowlist excludes `scripts/`, `config/`,
`api-reports/`, and the documentation site from the installable artifact.
Generated build output lives in the ignored `dist/` directory; temporary reports,
local logs, and archived working files belong under the ignored `.tmp/` directory.

## Changes and pull requests

- Explain the problem, the resulting behavior, and how you checked it.
- Preserve the public import paths `intention-kernel` and `intention-kernel/testing`.
- Document public contracts with TSDoc. Run `npm run docs:generate` and include the resulting changes under `api-reports/` and `docs/reference/`.
- Add regression coverage for changes to authorization, persistence, public contracts, or other critical behavior. Keep documentation-only changes focused.
- Record user-facing changes in `CHANGELOG.md`; the documentation site uses that same file.
- Keep credentials, provider output, local history, and temporary artifacts out of commits.

See the [development guide](https://simtlix.github.io/intention-kernel/development/testing.html) for individual checks and the [release policy](https://simtlix.github.io/intention-kernel/releases.html) for compatibility expectations. Report vulnerabilities through the process in [SECURITY.md](SECURITY.md).

Contributions are provided under the project's [Apache License 2.0](LICENSE).
