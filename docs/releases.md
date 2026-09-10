---
description: Download Intention Kernel releases from GitHub and review the Apache 2.0 license, versioning policy, compatibility guarantees, and release validation.
---

# Releases and compatibility

Intention Kernel is licensed under Apache-2.0. [GitHub releases](https://github.com/simtlix/intention-kernel/releases) provide versioned
source, an installable package tarball, and its SHA-256 checksum. The package
retains `private: true` to prevent accidental publication to the npm registry;
this setting does not restrict its license or GitHub distribution.

Every release must pass CI on Linux and Windows with Node 22, including types,
lint, behavior tests, generated API reports, documentation links, package-content
inspection, and installation into a clean consumer using TypeScript 5.9.3.
The release tag must match the package and runtime versions.

The installable package contains both public entry points, their JavaScript and
TypeScript declarations, source maps with the corresponding TypeScript sources,
and the README, changelog, license, security policy, and contribution guide.
The sources support debugger and editor navigation; applications import through
`intention-kernel` and `intention-kernel/testing`.

Guides and API references are published on the documentation site. The source
repository also contains development scripts, tests, and examples used to verify
the library; those development files are not shipped in the installable package.

The supported runtime is Node.js 22 with ESM imports. TypeScript consumers should
use version 5.9 or newer. The in-memory durability adapter is intended for tests
and local examples; production hosts must supply transactional persistence.

Breaking public API changes are allowed between `0.x` minor versions and must be
recorded in `CHANGELOG.md`. After `1.0.0`, incompatible changes require a major
version.

See [Publishing from GitHub](development/releasing.md) for the release workflow
and Pages configuration. npm trusted publishing and provenance are separate
requirements for any future npm registry release.
