#!/usr/bin/env python3
"""Generate a reference-guided sprite sheet through the user's Azure GPT Image deployment."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shlex
import struct
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler
import uuid

ROOT = Path(__file__).resolve().parents[3]


def configuration():
    wanted = {"AI_IMAGE_ENDPOINT", "AI_IMAGE_API_KEY", "AI_IMAGE_MODEL"}
    values = {}
    for line in (Path.home() / ".env").read_text().splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[7:]
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw = line.split("=", 1)
        if key.strip() in wanted:
            parts = shlex.split(raw, comments=True)
            if len(parts) == 1:
                values[key.strip()] = parts[0]
    missing = wanted - values.keys()
    if missing:
        raise ValueError("Missing image configuration keys: " + ", ".join(sorted(missing)))
    endpoint = values["AI_IMAGE_ENDPOINT"].rstrip("/")
    parsed = urlparse(endpoint)
    if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(
        (".openai.azure.com", ".services.ai.azure.com", ".cognitiveservices.azure.com", ".azure-api.net")
    ):
        raise ValueError("Expected a configured HTTPS Azure image endpoint.")
    return values, endpoint


def multipart(fields, references):
    boundary = "copilot-image-" + uuid.uuid4().hex
    sections = []
    for key, value in fields.items():
        sections.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode()
        )
    field = "image[]" if len(references) > 1 else "image"
    for index, reference in enumerate(references):
        sections.extend([
            (f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="reference-{index}.png"\r\n'
             "Content-Type: image/png\r\n\r\n").encode(),
            reference, b"\r\n",
        ])
    sections.append(f"--{boundary}--\r\n".encode())
    return b"".join(sections), boundary


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise RuntimeError("Image endpoint redirected; refusing to forward credentials.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", type=Path, default=ROOT / "characters/copilot/source/sprite-prompts/right-turn.txt")
    parser.add_argument("--output", type=Path, default=ROOT / "characters/copilot/source/generated-sprites/right-turn-sheet.png")
    parser.add_argument("--guide", type=Path, help="Optional layout guide supplied alongside the character reference.")
    parser.add_argument("--reference", type=Path, action="append",
                        help="Reference PNG; repeat to include approved frames. Defaults to original artwork.")
    args = parser.parse_args()
    args.prompt = args.prompt.resolve()
    args.output = args.output.resolve()
    values, endpoint = configuration()
    prompt = args.prompt.read_text()
    reference_paths = args.reference or [ROOT / "characters/copilot/source/copilot-source.png"]
    reference_path = reference_paths[0]
    reference = reference_path.read_bytes()
    fields = {"prompt": prompt, "n": "1", "size": "1536x1024", "quality": "high", "output_format": "png"}
    if endpoint.endswith("/openai/v1"):
        url = endpoint + "/images/edits"
        fields["model"] = values["AI_IMAGE_MODEL"]
    else:
        deployment = quote(values["AI_IMAGE_MODEL"], safe="")
        url = endpoint + f"/openai/deployments/{deployment}/images/edits?api-version=2025-04-01-preview"
    references = [path.read_bytes() for path in reference_paths]
    if args.guide:
        references.append(args.guide.read_bytes())
    body, boundary = multipart(fields, references)
    request = Request(url, data=body, method="POST", headers={
        "api-key": values["AI_IMAGE_API_KEY"],
        "Content-Type": "multipart/form-data; boundary=" + boundary,
    })
    print("Generating one reference-guided sprite sheet: 1536x1024, high quality, PNG.", flush=True)
    start = time.monotonic()
    try:
        with build_opener(NoRedirect()).open(request, timeout=600) as response:
            result = json.load(response)
    except HTTPError as error:
        try:
            detail = json.loads(error.read()).get("error", {})
        except json.JSONDecodeError:
            detail = {"message": "Image endpoint returned a non-JSON error response."}
        raise RuntimeError(f"Azure image API HTTP {error.code}: {detail.get('code', '')} {detail.get('message', '')}") from None
    if not isinstance(result.get("data"), list) or not result["data"]:
        raise RuntimeError("Image API returned no image data.")
    encoded = result["data"][0].get("b64_json")
    if not encoded:
        raise RuntimeError("Image API returned no base64 PNG.")
    png = base64.b64decode(encoded, validate=True)
    if png[:8] != b"\x89PNG\r\n\x1a\n" or struct.unpack(">II", png[16:24]) != (1536, 1024):
        raise RuntimeError("Generated image does not match the required 1536x1024 PNG format.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(png)
    metadata = {
        "created": datetime.now(timezone.utc).isoformat(),
        "provider": "Configured Azure GPT Image deployment",
        "reference": str(reference_path.resolve().relative_to(ROOT)),
        "references": [{"file": str(path.resolve().relative_to(ROOT)),
                        "sha256": hashlib.sha256(data).hexdigest()}
                       for path, data in zip(reference_paths, references)],
        "referenceSha256": hashlib.sha256(reference).hexdigest(),
        "prompt": str(args.prompt.relative_to(ROOT)),
        "promptText": prompt,
        "promptSha256": hashlib.sha256(prompt.encode()).hexdigest(),
        "size": [1536, 1024], "quality": "high", "format": "png",
        "generationSeconds": round(time.monotonic() - start, 2),
        "sha256": hashlib.sha256(png).hexdigest(),
        "usage": result.get("usage"),
    }
    if args.guide:
        metadata["layoutGuide"] = str(args.guide.resolve().relative_to(ROOT))
        metadata["layoutGuideSha256"] = hashlib.sha256(args.guide.read_bytes()).hexdigest()
    args.output.with_suffix(".json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Saved {args.output} ({len(png):,} bytes) in {metadata['generationSeconds']:.1f}s.", flush=True)


if __name__ == "__main__":
    main()
