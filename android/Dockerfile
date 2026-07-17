# Buildr101 Android builder — wraps a published PWA into a signed APK + AAB via Bubblewrap (TWA).
# Built ONCE on the VPS (`docker build -t buildr-android:latest android/`); the shell runs it per
# export (`docker run --rm -v <work>:/work buildr-android:latest`). Nothing Android touches the
# host — same "toolchain lives in a container" pattern as the alpine-chrome renderer.
#
# The image bakes JDK 17 + Android SDK (platform 34 + build-tools) + @bubblewrap/cli AND primes
# the Gradle/SDK caches with a throwaway build, so a real export is ~1-2 min instead of ~8 cold.

FROM eclipse-temurin:17-jdk

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    DEBIAN_FRONTEND=noninteractive \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/usr/local/bin:$PATH

# Node 20 (for bubblewrap) + unzip + git
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip git ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Android command-line tools
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && curl -fsSL -o /tmp/cmdtools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
    && unzip -q /tmp/cmdtools.zip -d ${ANDROID_HOME}/cmdline-tools \
    && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm /tmp/cmdtools.zip

# SDK packages + licenses (Bubblewrap targets these)
RUN yes | sdkmanager --licenses >/dev/null 2>&1 || true \
    && sdkmanager --install "platform-tools" "platforms;android-34" "build-tools;34.0.0" >/dev/null \
    && ln -s ${ANDROID_HOME}/cmdline-tools/latest ${ANDROID_HOME}/tools  # bubblewrap validates ${sdk}/tools

RUN npm install -g @bubblewrap/cli@latest \
    && mkdir -p /root/.bubblewrap \
    && printf '{"jdkPath":"%s","androidSdkPath":"%s"}' "$JAVA_HOME" "$ANDROID_HOME" > /root/.bubblewrap/config.json

# Gradle itself is NOT baked — the shell runs the container with a persistent named volume mounted
# at /root/.gradle (`-v buildr-gradle:/root/.gradle`), so the first export populates the cache and
# later exports reuse it. (Baking a primed cache proved fragile; a shared volume is simpler.)

COPY build.sh /usr/local/bin/build.sh
RUN chmod +x /usr/local/bin/build.sh

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/build.sh"]
