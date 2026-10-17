# Shared synthetic media fixtures

`media/` contains media shared by the frontend playback tests, server integration
tests and browser suite. `test/e2e/fixtures/upstream.mjs` serves local Bangumi
metadata, an XPath rule website and these videos. No external network request is
required by the browser suite. Server-only archive and rule fixtures live in
`test/server/fixtures/`.

`media/sample.mp4` is an original synthetic 20-second solid-color video with silent audio,
generated using FFmpeg. It is H.264/AAC so the browser can exercise real playback,
HTTP Range requests and watch-progress persistence. Regenerate with:

```sh
ffmpeg -f lavfi -i color=c=0x313749:s=160x90:r=15:d=20 \
  -f lavfi -i anullsrc=r=44100:cl=stereo -t 20 \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 32k -shortest test/fixtures/media/sample.mp4

ffmpeg -i test/fixtures/media/sample.mp4 -c copy -hls_time 5 -hls_list_size 0 \
  -hls_segment_filename test/fixtures/media/segment%02d.ts test/fixtures/media/sample.m3u8
```

Episode 1 uses MP4; episode 2 uses the derived HLS playlist and segments. The browser
suite therefore exercises both native MP4 and hls.js playback through the proxy.

The runner at `test/e2e/run-app.mjs` uses a disposable data directory and enables
private upstream addresses only in its child process so the application can reach
these loopback fixtures.
