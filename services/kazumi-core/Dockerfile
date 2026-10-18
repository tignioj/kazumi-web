FROM ghcr.io/cirruslabs/flutter:3.44.0 AS sdk
# Match the SDK required by the pinned Kazumi commit; no upstream files are patched.
RUN git -C /sdks/flutter fetch --depth 1 origin abaf9c523780a608bd46686fd5e53740a07077f8 \
    && git -C /sdks/flutter checkout abaf9c523780a608bd46686fd5e53740a07077f8 \
    && flutter precache --linux
RUN apt-get update && apt-get install -y --no-install-recommends \
    clang cmake ninja-build pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev \
    libayatana-appindicator3-dev libmpv-dev libsecret-1-dev \
    && rm -rf /var/lib/apt/lists/*
RUN git -C /sdks/flutter tag --force 3.47.7 abaf9c523780a608bd46686fd5e53740a07077f8 \
    && rm -f /sdks/flutter/bin/cache/flutter.version.json \
    && flutter --version
WORKDIR /service
COPY pubspec.yaml pubspec.lock ./
RUN flutter pub get

FROM sdk AS build
COPY . .
RUN flutter analyze && flutter test && flutter build linux --release \
    && mv build/linux/*/release/bundle /bundle
RUN cc -Wall -Wextra -Werror test/webkit_media_smoke.c -o /webkit-media-smoke \
    $(pkg-config --cflags --libs webkit2gtk-4.1)

FROM ubuntu:24.04 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgtk-3-0t64 libwebkit2gtk-4.1-0 libayatana-appindicator3-1 libmpv2 libsecret-1-0 \
    gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav \
    xvfb xauth tini dbus-x11 fonts-noto-cjk ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 kazumi && mkdir /data && chown kazumi:kazumi /data
WORKDIR /app
COPY --from=build /bundle/ ./
ENV XDG_DATA_HOME=/data LIBGL_ALWAYS_SOFTWARE=1 HOST=0.0.0.0 PORT=7331
USER kazumi
# Source players check WebKit's codec support before requesting HLS media.
# Test the final runtime so missing plugins fail the build instead of timing out.
RUN --mount=type=bind,from=build,source=/webkit-media-smoke,target=/tmp/webkit-media-smoke \
    dbus-run-session -- xvfb-run -a /tmp/webkit-media-smoke
EXPOSE 7331
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
    CMD curl -fs http://127.0.0.1:7331/health || exit 1
ENTRYPOINT ["tini", "--", "dbus-run-session", "--", "xvfb-run", "-a", "-s", "-screen 0 1280x720x24", "/app/kazumi_core"]
