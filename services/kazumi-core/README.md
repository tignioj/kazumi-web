# Kazumi core service

This Flutter host depends directly on `Predidit/Kazumi` at the Git commit in
`pubspec.yaml`. It imports upstream classes without copying or patching source.

The HTTP adapter provides `/health`, `/validate`, `/search`, `/chapters`,
`/resolve`, `/cancel` and `/captcha/*`. Only the Node service should access it.
`KAZUMI_EGRESS_PROXY` is required: rule requests and Linux WebView traffic use
the Node egress proxy, which applies the existing network settings and DNS guards.

Build and test with `docker build -t kazumi-core:local services/kazumi-core`.
The runtime includes GStreamer H.264/AAC plugins: source players need WebKit's
MP4/MSE support to start requesting HLS, even though playback happens in the
user's browser. A headless WebKit smoke check verifies those capabilities in
the final runtime during the image build.
For a dependency update, change the Git ref, resolve and commit `pubspec.lock`,
then run the Dart tests and complete HTTP/browser checks.

`flutter-sdk.json` pins the Flutter revision and the version required by Kazumi.
The `toolchain` Docker stage exposes that SDK without resolving application
dependencies, so the release-update workflow can regenerate the lockfile. Normal
image builds enforce the committed lockfile. The daily `Check Kazumi releases`
workflow proposes newer stable releases as pinned PRs; `Verify` builds this image,
starts a fresh core container, checks its revision/API, and runs browser tests
against its real rule engine and WebView resolver before a maintainer merges.
