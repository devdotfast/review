# Review Desktop

Review Desktop is the Progressive Review UI: a desktop app for authoring and
reading code reviews, built on a pinned fork of
[Code - OSS](https://github.com/microsoft/vscode).

- The app and its build live in [`apps/review-desktop`](apps/review-desktop)
  — start with its [README](apps/review-desktop/README.md).
- The Review CLI, embedded server, and canvas UI live in
  [`packages/progressive-review`](packages/progressive-review).

## Build and run

See [prerequisites](apps/review-desktop/README.md#prerequisites), then:

```sh
pnpm install
pnpm dev
```

## License

MIT. The vendored Code - OSS fork retains its Microsoft MIT license and
third-party notices; see
[`apps/review-desktop/LICENSE`](apps/review-desktop/LICENSE) and
[`apps/review-desktop/UPSTREAM`](apps/review-desktop/UPSTREAM).
