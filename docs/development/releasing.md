# Publishing from GitHub

Intention Kernel distributes reviewed source and installable tarballs through GitHub. npm registry publication is disabled with `private: true` until a separate registry release process is configured.

The source repository is [simtlix/intention-kernel](https://github.com/simtlix/intention-kernel). Public documentation is hosted at [simtlix.github.io/intention-kernel](https://simtlix.github.io/intention-kernel/).

## Repository setup

Before the first public push, configure the GitHub repository:

1. Set the default branch to `main`.
2. Under **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source.
3. Enable **Private vulnerability reporting** under the repository's security settings.
4. Protect `main` and require the CI verification jobs on Linux and Windows for pull requests.

The workflow uses GitHub's built-in token. It does not need a personal access token for Pages or release assets. Deployment permissions are limited to the corresponding jobs, and documentation is deployed only after both verification jobs pass on the default branch.

## Prepare a version

Keep `package.json`, `package-lock.json`, `src/version.ts`, installation examples, and the corresponding section in `CHANGELOG.md` aligned. The documentation site's changelog includes the root changelog directly.

```sh
npm ci
npm run verify
npm audit --audit-level=high
npm run release:prepare -- v0.8.0
```

`release:prepare` validates the version and changelog, then writes an installable tarball, `SHA256SUMS`, and release notes to the ignored `.tmp/release/` directory. It prepares files locally; publication happens when the version tag is pushed to GitHub.

Review and commit source changes together with the generated API reports and reference pages. The CI job fails if regeneration changes those committed files.

## Publish a release

After the version's commit passes CI on `main`, create and push the matching tag:

```sh
git tag -a v0.8.0 -m "Intention Kernel 0.8.0"
git push origin v0.8.0
```

The tag triggers the full Linux and Windows verification again. GitHub creates a release with the verified tarball, checksum, and changelog notes only after those checks succeed. A tag that does not match the package version fails release preparation.

Confirm the release asset can be installed in a clean project and that the documentation is reachable from the repository's Pages URL. The documented package imports must work from the installed artifact.

GitHub release tags and workflow runs identify the source and build of each artifact; the attached checksum identifies its bytes. These are not npm provenance attestations. A future npm release must configure trusted publishing before enabling registry publication.

## Local Pages preview

`DOCS_BASE` controls the site's deployment path. The Pages workflow obtains it from GitHub, so repository sites, account sites, and custom domains use the corresponding base. Local development defaults to `/`.

For a repository named `intention-kernel`, build and preview with `DOCS_BASE=/intention-kernel/` set in the environment:

```sh
npm run docs:build
npm run docs:preview
```

The build checks every generated page's local links, anchors, and assets. URLs use `.html` so direct navigation does not depend on server rewrite rules.
