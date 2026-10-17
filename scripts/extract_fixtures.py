#!/usr/bin/env python3
"""Pull one BotGuard session out of a mitmproxy capture into fixtures/.

Writes challenge.json (the page's bgChallenge), interpreter.js (the script its
interpreterUrl names), and the capture's GenerateIT request/response for comparison.

usage: extract_fixtures.py <capture.flow> [outdir]
"""
import json
import re
import sys
from pathlib import Path

from mitmproxy.io import FlowReader


def bg_challenge(html: str) -> dict | None:
    at = html.find("bgChallenge")
    if at < 0:
        return None
    window = re.sub(r"\\x([0-9a-fA-F]{2})", lambda m: chr(int(m.group(1), 16)), html[at : at + 400_000])
    start = window.find("{")
    depth, in_str, esc = 0, False, False
    for i, ch in enumerate(window[start:], start):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    c = json.loads(window[start : i + 1])
                except json.JSONDecodeError:
                    return None
                return c if isinstance(c, dict) and "program" in c else None
    return None


def main() -> None:
    flow = sys.argv[1]
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "fixtures")
    out.mkdir(parents=True, exist_ok=True)
    challenges: list[dict] = []
    scripts: dict[str, bytes] = {}
    generate_it: list[tuple[bytes, bytes]] = []
    with open(flow, "rb") as fh:
        for fl in FlowReader(fh).stream():
            req = getattr(fl, "request", None)
            if req is None or fl.response is None:
                continue
            body = fl.response.get_content() or b""
            url = req.pretty_url
            if "/js/th/" in url:
                scripts[url.split("//", 1)[1]] = body
            elif "GenerateIT" in url:
                generate_it.append((req.get_content() or b"", body))
            elif b"bgChallenge" in body:
                c = bg_challenge(body.decode("utf-8", "replace"))
                if c:
                    challenges.append(c)
    for c in challenges:
        url = c["interpreterUrl"]["privateDoNotAccessOrElseTrustedResourceUrlWrappedValue"].lstrip("/")
        if url in scripts:
            (out / "challenge.json").write_text(json.dumps(c))
            (out / "interpreter.js").write_bytes(scripts[url])
            print(f"challenge globalName={c['globalName']} program={len(c['program'])}B interpreter={url} {len(scripts[url])}B")
            break
    else:
        print(f"no challenge with a captured interpreter ({len(challenges)} challenges, {len(scripts)} scripts)")
    if generate_it:
        req, resp = generate_it[0]
        (out / "generateit.req.json").write_bytes(req)
        (out / "generateit.resp.json").write_bytes(resp)
        snapshot = json.loads(req)[1]
        print(f"GenerateIT: {len(generate_it)} calls, first snapshot {len(snapshot)} chars")


if __name__ == "__main__":
    main()
