# Contributing to Long Screen

Thanks for taking a look. This file has two parts: how to propose a change, and how the maintainer ships one (deploying the web app and releasing the packages).

## Proposing a change

- **Bugs and ideas:** open a [GitHub issue](https://github.com/t41372/long-screen/issues). For a wrong result, say which browser or package you used and, if you can share it, attach the recording or a short clip that shows the problem. A screenshot of the print and the diagnostics from the log sheet help too.
- **Pull requests:** small and focused is easiest to review. Say what changed and why, and how you checked it.

Setting up: install [Deno](https://deno.com) 2.x and [rustup](https://rustup.rs); rustup fetches the pinned Rust toolchain on the first build. Then:

```sh
deno task start   # build and serve the app on http://localhost:4173
deno task test    # Rust tests plus the Deno unit and scenario tests
deno task fmt     # format before you commit
deno task lint    # formatting, deno lint and clippy: run it before calling a change done
```

[AGENTS.md](AGENTS.md) holds the project's rules (it is written for coding agents, but it is the same rulebook for people). The ones that matter most:

- Algorithms live in the Rust crate (`rust/long-screen`); the TypeScript stays a thin shell around it.
- A change to the pipeline comes with evidence: a fingerprint comparison against `main` (`deno task fingerprint`), and for real recordings an A/B run. [docs/TESTING.md](docs/TESTING.md) explains both.
- UI text is added in both Chinese and English.

## Maintainer guide

### What ships where

Nothing is published by merging a pull request. Each target has its own trigger:

| What                         | Where it goes                                                                                     | What publishes it                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| The web app                  | https://long-screen.yi-ting.com and https://long-screen.pages.dev                                 | a push to `main` (Cloudflare Pages builds and deploys it) |
| Rust crate `long-screen`     | [crates.io](https://crates.io/crates/long-screen), docs on [docs.rs](https://docs.rs/long-screen) | a `crates-v<version>` tag                                 |
| Python package `long-screen` | [PyPI](https://pypi.org/project/long-screen/)                                                     | a `py-v<version>` tag                                     |
| npm package `long-screen`    | [npm](https://www.npmjs.com/package/long-screen)                                                  | an `npm-v<version>` tag                                   |

So pushing `main` updates the website straight away, and a tag sends one package to one registry. The three packages are built from the same source but versioned separately; you can release just one of them.

### Deploying the web app

Push to `main`. Cloudflare Pages runs `bash scripts/pages-build.sh` and publishes `dist/` within a few minutes; any other branch gets a preview URL instead. After a deploy, open the site and run the sample recording once. The threaded core needs the COOP/COEP headers from `static/_headers`; `curl -sI https://long-screen.yi-ting.com/` should list them. [README.md](README.md#deployment) has the details.

### Releasing

Version 0.1.0 of all three packages went out on 2026-10-12, from commit `748a0ac`. The first release of each needed one-off manual steps; those are written up in [docs/RELEASING.md](docs/RELEASING.md) (in Chinese), together with every settings page and button. From now on a release is the same short routine for each package.

**1. Pick the version and write it down.** Each package keeps its version in one file:

| Package | File                                                   | Tag             |
| ------- | ------------------------------------------------------ | --------------- |
| crate   | `rust/long-screen/Cargo.toml`                          | `crates-v0.1.1` |
| Python  | `rust/python/Cargo.toml`                               | `py-v0.1.1`     |
| npm     | `deno.json` (copied into the package's `package.json`) | `npm-v0.1.1`    |

A version number can be used only once per registry, forever, even if you delete it later. Think about it before tagging, not after.

**2. Check it on your machine.** On the commit you are going to release, with a clean `git status`:

```sh
deno task lint && deno task test
deno task test:python                                  # if releasing the Python package
deno test --allow-all tests/browser/package.test.ts    # if releasing the npm package (opens Chrome and WebKit)
cd rust && cargo publish --dry-run --locked -p long-screen   # if releasing the crate
```

**3. Push `main`.** This also deploys the website, so check the site afterwards.

**4. Optional dry run on GitHub.** Each release workflow can be started by hand from the Actions tab (**Run workflow**, branch `main`). A manual run builds and tests everything but publishes nothing. Do this when the release touches the build, the workflows or the platforms.

**5. Tag and push the tag.** For example:

```sh
git tag -a py-v0.1.1 -m "Python package 0.1.1" <commit>
git push origin py-v0.1.1
```

The workflow builds and tests on Linux, macOS and Windows, then checks that the tag matches the version in the file. If they differ it stops before uploading anything.

**6. Approve.** The last job of each workflow waits for you: open the run on the Actions tab and press **Review deployments → Approve and deploy**. This is the point of no return.

**7. Check the result.** Open the registry page, then install the new version somewhere fresh:

```sh
uv run --with long-screen==0.1.1 python -c "import long_screen"   # Python
cargo install long-screen --version 0.1.1 --root /tmp/ls && /tmp/ls/bin/long-screen --help   # crate
cd "$(mktemp -d)" && npm init -y && npm install long-screen@0.1.1   # npm
```

For the crate, also check that docs.rs built the documentation (a few minutes after publishing).

### Per-registry notes

None of the workflows holds a password or a long-lived token. They use _trusted publishing_: when a job runs, GitHub vouches for it ("this is `release-crates.yml` in `t41372/long-screen`, environment `crates-io`") and the registry hands it a short-lived upload permission. Each registry has to be told once which repository, workflow file and environment to trust.

- **PyPI:** set up and already used for 0.1.0. Nothing to do.
- **crates.io:** 0.1.0 was uploaded by hand (crates.io only allows trusted publishing for a crate that already exists), and the `crates-v0.1.0` run skipped its upload because the version was already there. So the trusted-publishing setting has not been exercised yet; the first tag-driven upload will be 0.1.1. If that upload fails with an authorization error, compare the settings at https://crates.io/crates/long-screen/settings (owner `t41372`, repository `long-screen`, workflow `release-crates.yml`, environment `crates-io`) and press **Re-run failed jobs**. Once a tag has published successfully, consider turning on **Trusted Publishing only** there, which stops API tokens from publishing.
- **npm:** not set up yet, on purpose. npm deletes a new trusted-publisher setting that has not been used within 48 hours, so create it on the day you push the next `npm-v` tag: https://www.npmjs.com/package/long-screen/access → **Trusted Publisher** → GitHub Actions, with `t41372` / `long-screen` / `release-npm.yml` / `npm`, and tick **npm publish** under allowed actions. After that first automatic release, set **Publishing access** to "Require two-factor authentication and disallow tokens".

### Lessons from the first release

- Commands that ask for a browser login or a 2FA code (`npm login`, `npm publish`, `cargo login`) need a real terminal. Run them yourself; a script or an assistant's shell cannot wait for the browser step.
- A token made for a one-off upload should be the narrowest kind (crates.io: 7 days, `publish-new` only, limited to `long-screen`). Revoke it on the website as soon as the upload is done; `cargo logout` only deletes the local copy.
- A brand-new npm package shows a placeholder version `0.0.0-stage` for a few minutes while npm processes the upload. `latest` points at the real version once it is done.
- The crate's packaging warnings about examples and tests "not included in the published package" are expected: `include` in `rust/long-screen/Cargo.toml` leaves them out on purpose.

### When something goes wrong

- **The tag was wrong and nothing was uploaded yet** (the workflow stopped at the version check or a test): delete the tag (`git push origin :refs/tags/<tag>` and `git tag -d <tag>`), fix, push `main`, tag again.
- **A transient GitHub failure** (network, runner): press **Re-run failed jobs**. Re-running is safe: each workflow skips a version that is already on its registry.
- **A bad version was published:** you cannot overwrite or reuse it. Publish a fixed version (say 0.1.2), then mark the bad one: `cargo yank --version 0.1.1 long-screen`, "yank" on PyPI's release page, or `npm deprecate long-screen@0.1.1 "use 0.1.2"`. Existing users keep working; new installs skip it.
- **A secret was published by mistake:** revoke the secret first. Yanking and deprecating do not delete files.
