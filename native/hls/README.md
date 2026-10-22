# Kazumi native HLS transport

The ad filter is the unmodified FFmpeg patch from Predidit's Android libmpv
build, the playback path used by Kazumi. `upstream.json` pins the official build
repository commit, its FFmpeg dependency commit, and SHA-256 hashes of both inputs.
`ffmpeg-hls-kazumi-combined.patch` is vendored byte-for-byte at that revision.
The build verifies this local file before any network request, then applies it
with zero fuzz; it never downloads a replacement patch. `patchUrl` records provenance.

Run `npm run build:hls` with Node 24, a C compiler, make, tar and patch (Docker
builds these tools automatically). This builds `bin/kazumi-ffmpeg` and
`bin/kazumi-ffprobe` on macOS or Linux. No external codec libraries or encoders
are enabled. The Docker image uses the same script for its target architecture.
The binaries include `hls_ad_filter`, unlike stock FFmpeg. The optional
`KAZUMI_FFMPEG_PATH` and `KAZUMI_FFPROBE_PATH` overrides must point to builds with
the same upstream patch; errors never fall back to a JavaScript filter.

`npm run check:hls` verifies the vendored patch without downloading or compiling.
FFmpeg's pinned source archive is downloaded and hash-checked on a cold build.
For an offline build with the toolchain already installed, supply that exact
archive locally:

```bash
HLS_SOURCE_ARCHIVE=/absolute/path/ffmpeg.tar.gz npm run build:hls
```

An incorrect local archive fails its SHA-256 check without a download fallback.
`HLS_CACHE_DIR` optionally selects the build-cache parent directory (default:
the system temporary directory). The source cache identity includes both source
and patch hashes. A changed identity or incomplete extraction triggers a clean
extraction and patch application; an old marker's presence alone cannot reuse
stale source. Configure and make run on each build. This fixes source inputs and
the build recipe; byte-identical binaries across different OS/compiler versions
are not promised. Docker copies the same patch and runs the same script.

FFmpeg can only access HTTP media routes on the Node service itself, with the
`http,tcp,crypto` input protocol allowlist. All upstream requests, cookie/header
scoping, redirects, DNS checks, TLS and proxy settings stay in the existing media
proxy. Native commands never receive origin credentials or arbitrary input URLs.
Input manifests are preserved and rewritten only for transport. Output is a
back-pressured fragmented MP4 pipe with stream copying, without transcoding or a
temporary episode on disk. Seeking aborts the old process, uses native HLS
seeking, and preserves the target's timestamp position in MediaSource. MP4Box.js
reads the init segment's codec information; it makes no ad decisions.

Cached HLS retains original manifests, keys and segments, plus the rule's filter
flag. Replaying it uses the same native filter against local cache HTTP routes.
Exported HLS archives retain the source packets, including any ads; standalone
players need their own filtering support. Caches created by the old destructive
playlist filter cannot recover discarded segments and must be downloaded again.

To update, change the official build revision and its matching FFmpeg dependency
together, replace the vendored patch with the exact upstream bytes, recalculate
hashes, and run the native regression tests plus browser seek/resume checks.
Do not modify the vendored algorithm. Keep the FFmpeg license files, vendored
patch and `hls-upstream.json` distributed with the binaries; the pinned
source URL and build script provide the corresponding source and build recipe.
