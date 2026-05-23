import datetime as dt
import ipaddress
import os
import socket
from pathlib import Path
from typing import Iterable, Tuple

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


SSL_DIR = Path(os.environ.get("FILE_PIPE_SSL_DIR", Path(__file__).resolve().parent / "ssl")).expanduser()
CERT_PATH = SSL_DIR / "file-pipe-local.crt"
KEY_PATH = SSL_DIR / "file-pipe-local.key"


def ensure_local_certificate(host: str = "127.0.0.1") -> Tuple[str, str]:
    names, addresses = local_subject_alt_names(host)
    if certificate_matches(names, addresses):
        return str(CERT_PATH), str(KEY_PATH)

    SSL_DIR.mkdir(mode=0o700, exist_ok=True)
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name(
        [
            x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "File Pipe Local"),
            x509.NameAttribute(NameOID.COMMON_NAME, "File Pipe Local Development"),
        ]
    )
    san_entries = [x509.DNSName(name) for name in sorted(names)]
    san_entries.extend(x509.IPAddress(address) for address in sorted(addresses, key=str))
    now = dt.datetime.now(dt.timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(private_key, hashes.SHA256())
    )

    KEY_PATH.write_bytes(
        private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    KEY_PATH.chmod(0o600)
    CERT_PATH.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    return str(CERT_PATH), str(KEY_PATH)


def certificate_matches(required_names: Iterable[str], required_addresses: Iterable[ipaddress._BaseAddress]) -> bool:
    if not CERT_PATH.exists() or not KEY_PATH.exists():
        return False
    try:
        certificate = x509.load_pem_x509_certificate(CERT_PATH.read_bytes())
        san = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        cert_names = set(san.get_values_for_type(x509.DNSName))
        cert_addresses = set(san.get_values_for_type(x509.IPAddress))
    except Exception:
        return False
    if certificate.not_valid_after_utc <= dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=7):
        return False
    return set(required_names).issubset(cert_names) and set(required_addresses).issubset(cert_addresses)


def local_subject_alt_names(host: str):
    names = {"localhost"}
    addresses = {ipaddress.ip_address("127.0.0.1"), ipaddress.ip_address("::1")}
    add_host_value(host, names, addresses)
    for candidate in local_host_candidates():
        add_host_value(candidate, names, addresses)
    names.discard("0.0.0.0")
    names.discard("::")
    return names, addresses


def local_host_candidates():
    candidates = set()
    for value in (socket.gethostname(), socket.getfqdn()):
        if value:
            candidates.add(value)
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            candidates.add(info[4][0])
    except socket.gaierror:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            candidates.add(sock.getsockname()[0])
    except OSError:
        pass
    return candidates


def add_host_value(value: str, names, addresses) -> None:
    if not value:
        return
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        names.add(value)
        return
    if not address.is_unspecified:
        addresses.add(address)
