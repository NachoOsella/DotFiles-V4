#!/usr/bin/env python3
"""
Security headers verifier for a given URL.
Checks the presence and quality of recommended HTTP response security headers.

Usage:
    python headers_verifier.py https://example.com [--strict]

Exit codes:
    0 = all recommended headers present and well-configured
    1 = one or more recommended headers missing or misconfigured
"""

import argparse
import sys
import urllib.request
import urllib.error
from urllib.parse import urlparse


def check_url(url: str, strict: bool = False) -> int:
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "security-headers-verifier/1.0"})
        response = urllib.request.urlopen(req, timeout=15)
    except urllib.error.HTTPError as e:
        # Some servers don't support HEAD; try GET
        req = urllib.request.Request(url, method="GET", headers={"User-Agent": "security-headers-verifier/1.0"})
        try:
            response = urllib.request.urlopen(req, timeout=15)
        except urllib.error.HTTPError as e2:
            print(f"[!] HTTP error: {e2.code} {e2.reason}")
            return 1
    except Exception as e:
        print(f"[!] Request failed: {e}")
        return 1

    headers = {k.lower(): v for k, v in response.headers.items()}
    issues = []
    warnings = []

    # Strict-Transport-Security
    hsts = headers.get("strict-transport-security")
    if not hsts:
        issues.append("Missing Strict-Transport-Security (HSTS)")
    elif "max-age=" not in hsts.lower():
        issues.append("HSTS header present but missing max-age")

    # Content-Security-Policy
    csp = headers.get("content-security-policy")
    if not csp:
        issues.append("Missing Content-Security-Policy")
    elif "default-src 'none'" in csp or "default-src 'self'" in csp:
        pass  # good
    elif strict:
        warnings.append("CSP is present but does not use restrictive default-src")

    # X-Frame-Options
    xfo = headers.get("x-frame-options")
    if not xfo:
        issues.append("Missing X-Frame-Options")
    elif xfo.upper() not in {"DENY", "SAMEORIGIN"}:
        issues.append("X-Frame-Options should be DENY or SAMEORIGIN")

    # X-Content-Type-Options
    xcto = headers.get("x-content-type-options")
    if not xcto:
        issues.append("Missing X-Content-Type-Options")
    elif xcto.lower() != "nosniff":
        issues.append("X-Content-Type-Options should be nosniff")

    # Referrer-Policy
    rp = headers.get("referrer-policy")
    if not rp:
        issues.append("Missing Referrer-Policy")
    elif rp.lower() not in {"no-referrer", "strict-origin-when-cross-origin", "same-origin"}:
        warnings.append("Referrer-Policy value could be more restrictive")

    # Permissions-Policy
    pp = headers.get("permissions-policy")
    if not pp:
        warnings.append("Missing Permissions-Policy (recommended)")

    # Cross-Origin-Opener-Policy
    coop = headers.get("cross-origin-opener-policy")
    if not coop:
        warnings.append("Missing Cross-Origin-Opener-Policy (recommended)")

    print(f"URL: {url}")
    print(f"Status: {response.status}")
    print("\nHeaders found:")
    for name, value in sorted(headers.items()):
        print(f"  {name}: {value}")

    if warnings:
        print("\nWarnings:")
        for w in warnings:
            print(f"  - {w}")

    if issues:
        print("\nIssues:")
        for i in issues:
            print(f"  [!] {i}")
        return 1

    print("\n[OK] All recommended security headers are present.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify HTTP security headers")
    parser.add_argument("url", help="Target URL to inspect")
    parser.add_argument("--strict", action="store_true", help="Enable stricter checks")
    args = parser.parse_args()

    parsed = urlparse(args.url)
    if not parsed.scheme:
        args.url = "https://" + args.url

    return check_url(args.url, strict=args.strict)


if __name__ == "__main__":
    sys.exit(main())
