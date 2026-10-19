# WebKit issuer chain compatibility

`sslcom-tls-issuing-rsa-r1.crt` is the public **SSL.com TLS Issuing RSA CA R1**
intermediate issued by **SSL.com TLS RSA Root CA 2022**. The root is already
trusted by Ubuntu. This supplies an alternate path for servers that still send
the version cross-signed by the retired **AAA Certificate Services** root.
Linux WebKit does not obtain the alternate intermediate automatically, so these
servers can silently fail to load player scripts and time out during sniffing.

Source: [SSL.com CA repository](https://www.ssl.com/repository/),
[official PEM](https://repo-certs.ssl.com/repo/certs/SSL.com-TLS-I-RSA-R1.pem).
The checked-in file contains only the PEM certificate, without the download's
subject/issuer preamble.

- Certificate SHA-256: `BFBC39E9FA2B84C9A92337E2344EE2381D8D3D3AE8EA75EF4E48E5807ED80C69`
- Validity: 2022-10-21 through 2032-10-18.

The Docker build verifies the intermediate against the existing system root
bundle **before** adding it to the system certificate store. It fails if that
chain is untrusted or expired. This supplements a shared issuer chain; it does
not trust a site's leaf certificate, reinstate the retired root, or turn off
certificate/hostname verification. Rebuild images to pick up root-store updates;
remove the intermediate if its issuer is no longer trusted.
