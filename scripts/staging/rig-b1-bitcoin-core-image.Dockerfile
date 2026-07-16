# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# RIG-B1 uses the reviewed Bitcoin Core 31.1 x86_64 release archive. The base
# image and upstream archive are both immutable inputs; there is no package
# installation or mutable repository lookup in this build.
FROM debian@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS verify

ARG BITCOIN_CORE_VERSION=31.1
ARG BITCOIN_CORE_ARCHIVE=bitcoin-31.1-x86_64-linux-gnu.tar.gz
ARG BITCOIN_CORE_ARCHIVE_SHA256=b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e

COPY ${BITCOIN_CORE_ARCHIVE} /tmp/bitcoin-core.tar.gz
RUN printf '%s  %s\n' "${BITCOIN_CORE_ARCHIVE_SHA256}" /tmp/bitcoin-core.tar.gz \
      | sha256sum --check --strict - \
    && mkdir -p \
      /rootfs/usr/local/bin \
      /rootfs/lib/x86_64-linux-gnu \
      /rootfs/lib64 \
      /rootfs/etc \
      /rootfs/home/bitcoin/.bitcoin \
    && tar --extract --gzip --file=/tmp/bitcoin-core.tar.gz --directory=/tmp \
    && install -m 0755 "/tmp/bitcoin-${BITCOIN_CORE_VERSION}/bin/bitcoind" /rootfs/usr/local/bin/bitcoind \
    && install -m 0755 "/tmp/bitcoin-${BITCOIN_CORE_VERSION}/bin/bitcoin-cli" /rootfs/usr/local/bin/bitcoin-cli \
    && for library in \
      libc.so.6 libm.so.6 libpthread.so.0 libnss_dns.so.2 \
      libnss_files.so.2 libresolv.so.2; do \
        cp -L "/lib/x86_64-linux-gnu/${library}" "/rootfs/lib/x86_64-linux-gnu/${library}"; \
      done \
    && cp -L /lib64/ld-linux-x86-64.so.2 /rootfs/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 \
    && ln -s ../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 /rootfs/lib64/ld-linux-x86-64.so.2 \
    && printf '%s\n' 'hosts: files dns' > /rootfs/etc/nsswitch.conf \
    && printf '%s\n' 'bitcoin:x:10001:10001:Bitcoin Core:/home/bitcoin:/sbin/nologin' > /rootfs/etc/passwd \
    && printf '%s\n' 'bitcoin:x:10001:' > /rootfs/etc/group \
    && chown -R 10001:10001 /rootfs/home/bitcoin \
    && /rootfs/usr/local/bin/bitcoind --version | grep -F "Bitcoin Core daemon version v${BITCOIN_CORE_VERSION}.0"

FROM scratch

LABEL org.opencontainers.image.title="Arkova RIG-B1 Bitcoin Core Signet" \
      org.opencontainers.image.version="31.1" \
      org.opencontainers.image.source="https://bitcoincore.org/bin/bitcoin-core-31.1/bitcoin-31.1-x86_64-linux-gnu.tar.gz" \
      org.opencontainers.image.revision="b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e"

COPY --from=verify /rootfs /

ENV HOME=/home/bitcoin
USER 10001:10001
WORKDIR /home/bitcoin
EXPOSE 38333
ENTRYPOINT ["/usr/local/bin/bitcoind"]
