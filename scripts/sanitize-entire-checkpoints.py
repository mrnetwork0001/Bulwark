#!/usr/bin/env python3
"""Make Entire checkpoints safe to publish.

Entire stores each Claude Code session transcript under refs/entire/checkpoints/*.
It redacts secrets in text, but images pasted into a session (screenshots) are
stored as base64 and can show things like API keys. This rewrites every
checkpoint commit that isn't on a branch:

  - every image block becomes a short text placeholder,
  - any value from .env that looks like a secret is replaced with REDACTED
    (a second line of defence; Entire's own redaction normally covers text),
  - content_hash.txt is recomputed (Entire stores sha256 of full.jsonl).

Checkpoint ids (the ref names) and commit messages/dates are kept, so
`Entire-Checkpoint:` trailers on code commits still resolve. Run it before
pushing refs/entire/*, then verify with --check.

  python3 scripts/sanitize-entire-checkpoints.py           # rewrite local refs
  python3 scripts/sanitize-entire-checkpoints.py --check   # exit 1 if anything unsafe remains
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

PLACEHOLDER = "[image removed before publishing]"
TEXT_EXT = (".jsonl", ".json", ".txt", ".md")
B64_IMAGE = re.compile(r"(iVBORw0KGgo|/9j/4|R0lGOD|UklGR)[A-Za-z0-9+/=]{200,}")


def git(*args, input=None, env=None):
    res = subprocess.run(["git", *args], input=input, capture_output=True, env=env)
    if res.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {res.stderr.decode()[:300]}")
    return res.stdout


def secrets():
    vals = []
    if os.path.exists(".env"):
        for line in open(".env", encoding="utf-8"):
            m = re.match(r"^\s*([A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*(\S+)", line)
            if m and len(m.group(3)) >= 12:
                vals.append(m.group(3).strip("'\""))
    return vals


SECRETS = secrets()


def scrub_value(v):
    if isinstance(v, dict):
        if v.get("type") == "image":
            return {"type": "text", "text": PLACEHOLDER}
        return {k: scrub_value(x) for k, x in v.items()}
    if isinstance(v, list):
        return [scrub_value(x) for x in v]
    if isinstance(v, str):
        v = B64_IMAGE.sub(PLACEHOLDER, v)
        for s in SECRETS:
            if s in v:
                v = v.replace(s, "REDACTED")
    return v


def scrub_text(text, jsonl):
    out = []
    for line in text.split("\n"):
        if jsonl and line.strip():
            try:
                obj = json.loads(line)
                new = scrub_value(obj)
                if new != obj:
                    line = json.dumps(new, ensure_ascii=False, separators=(",", ":"))
                out.append(line)
                continue
            except ValueError:
                pass
        line = B64_IMAGE.sub(PLACEHOLDER, line)
        for s in SECRETS:
            line = line.replace(s, "REDACTED")
        out.append(line)
    return "\n".join(out)


def unsafe(text):
    return '"type":"image"' in text or bool(B64_IMAGE.search(text)) or any(s in text for s in SECRETS)


def checkpoint_commits():
    refs = git("for-each-ref", "--format=%(refname)", "refs/entire/").decode().split()
    if not refs:
        return refs, []
    revs = git("rev-list", "--reverse", "--topo-order", *refs, "--not", "--branches").decode().split()
    return refs, revs


def check():
    refs, revs = checkpoint_commits()
    bad = 0
    for c in revs:
        for path in git("ls-tree", "-r", "--name-only", c).decode().splitlines():
            if path.endswith(TEXT_EXT) and unsafe(git("show", f"{c}:{path}").decode("utf-8", "replace")):
                bad += 1
                print(f"unsafe: {c[:10]} {path}")
                break
    print(f"{len(refs)} checkpoint refs, {len(revs)} commits, {bad} unsafe")
    return bad


def rewrite():
    refs, revs = checkpoint_commits()
    blob_cache, mapped = {}, {}
    for c in revs:
        idx = tempfile.mktemp(prefix="entire-idx-")
        env = {**os.environ, "GIT_INDEX_FILE": idx}
        git("read-tree", c, env=env)
        entries = git("ls-files", "-s", env=env).decode().splitlines()
        new_full = {}
        for e in entries:
            meta, path = e.split("\t", 1)
            mode, sha, _ = meta.split()
            if not path.endswith(TEXT_EXT):
                continue
            if sha not in blob_cache:
                text = git("cat-file", "blob", sha).decode("utf-8", "replace")
                clean = scrub_text(text, path.endswith(".jsonl"))
                blob_cache[sha] = (git("hash-object", "-w", "--stdin", input=clean.encode()).decode().strip() if clean != text else sha, clean)
            new_sha, clean = blob_cache[sha]
            if new_sha != sha:
                git("update-index", "--cacheinfo", f"{mode},{new_sha},{path}", env=env)
            if path.endswith("/full.jsonl") or path == "full.jsonl":
                new_full[os.path.dirname(path)] = clean
        for d, clean in new_full.items():
            hp = f"{d}/content_hash.txt" if d else "content_hash.txt"
            if any(e.endswith("\t" + hp) for e in entries):
                h = "sha256:" + hashlib.sha256(clean.encode()).hexdigest()
                hsha = git("hash-object", "-w", "--stdin", input=h.encode()).decode().strip()
                git("update-index", "--cacheinfo", f"100644,{hsha},{hp}", env=env)
        tree = git("write-tree", env=env).decode().strip()
        os.unlink(idx)
        raw = git("cat-file", "commit", c).decode()
        header, msg = raw.split("\n\n", 1)
        parents = [mapped.get(p, p) for p in re.findall(r"^parent (\w+)", header, re.M)]
        a = re.search(r"^author (.*) <(.*)> (\d+ [+-]\d{4})$", header, re.M)
        m = re.search(r"^committer (.*) <(.*)> (\d+ [+-]\d{4})$", header, re.M)
        cenv = {**os.environ, "GIT_AUTHOR_NAME": a.group(1), "GIT_AUTHOR_EMAIL": a.group(2), "GIT_AUTHOR_DATE": a.group(3),
                "GIT_COMMITTER_NAME": m.group(1), "GIT_COMMITTER_EMAIL": m.group(2), "GIT_COMMITTER_DATE": m.group(3)}
        args = ["commit-tree", tree]
        for p in parents:
            args += ["-p", p]
        mapped[c] = git(*args, input=msg.encode(), env=cenv).decode().strip()
    for r in refs:
        old = git("rev-parse", r).decode().strip()
        if old in mapped:
            git("update-ref", r, mapped[old], old)
    print(f"rewrote {len(mapped)} commits across {len(refs)} checkpoint refs")


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(1 if check() else 0)
    rewrite()
    sys.exit(1 if check() else 0)
