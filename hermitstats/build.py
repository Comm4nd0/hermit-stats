"""Turn the database into the static site: per-video stats, per-Hermit word counts, and searchable
transcripts as JSON, next to the page in web/. All the heavy lifting happens here, on the home machine;
the server only serves files."""

import json
import math
import re
import shutil
import time
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

from . import db, text
from .config import Config
from .mentions import MentionFinder

WEB = Path(__file__).resolve().parent.parent / "web"
ALL = "*"           # words-file key for "every collection"
TOP_WORDS, TOP_BIGRAMS, TOP_TRIGRAMS = 1500, 600, 400
CHUNK_SECONDS = 20  # transcript search granularity

_EPISODE = re.compile(r"(?:\bep(?:isode)?\.?\s*#?\s*|#)(\d{1,3})\b", re.I)


def episode_number(title: str) -> int | None:
    m = _EPISODE.search(title or "")
    return int(m.group(1)) if m else None


def _date(d: str | None) -> str | None:
    return f"{d[:4]}-{d[4:6]}-{d[6:8]}" if d and len(d) == 8 else None


def _chunks(segments: list[dict]) -> list[list]:
    """Merge caption segments into ~20 s [start, text] chunks (auto-captions repeat lines; drop repeats)."""
    out, cur, start, last = [], [], None, None
    for s in segments:
        t = text.clean(s["text"]).replace("[Music]", "").strip()
        if not t or t == last:
            continue
        last = t
        if start is None:
            start = s["start"]
        cur.append(t)
        if s["start"] - start >= CHUNK_SECONDS:
            out.append([int(start), " ".join(cur)])
            cur, start = [], None
    if cur:
        out.append([int(start), " ".join(cur)])
    return out


def _distinctive(target: Counter, rest: Counter, top: int = 40, min_count: int = 8) -> list:
    """Words a Hermit uses far more than everyone else: log-odds ratio with an informative Dirichlet
    prior (Monroe et al. 2008), as z-scores. Robust to very different amounts of footage."""
    prior = target + rest
    a0 = sum(prior.values()) or 1
    n1, n2 = sum(target.values()) or 1, sum(rest.values()) or 1
    scale = 500 / a0      # prior strength: a modest pseudo-corpus shaped like the whole collection
    out = []
    for w, y1 in target.items():
        if y1 < min_count:
            continue
        a = prior[w] * scale
        a_sum = a0 * scale
        y2 = rest.get(w, 0)
        d = (math.log((y1 + a) / (n1 + a_sum - y1 - a)) - math.log((y2 + a) / (n2 + a_sum - y2 - a)))
        var = 1 / (y1 + a) + 1 / (y2 + a)
        out.append((w, round(d / math.sqrt(var), 2), y1))
    out.sort(key=lambda x: -x[1])
    return [list(x) for x in out[:top]]


def _avatar(url: str | None, dest: Path) -> bool:
    if dest.exists():
        return True
    if not url:
        return False
    # yt3 avatar URLs take a size suffix: ...=s900-c-k-... -> ...=s176-c-k-...
    small = re.sub(r"=s\d+", "=s176", url) if "=s" in url else url + "=s176"
    try:
        with urllib.request.urlopen(small, timeout=20) as r:
            dest.write_bytes(r.read())
        return True
    except OSError:
        return False


def build(conn, cfg: Config, out: Path, log=print) -> dict:
    finder = MentionFinder(cfg.hermits)
    hermits = {h.slug: h for h in cfg.hermits}
    colls = {c.name: c for c in cfg.collections}
    videos = []
    for v in db.analysable(conn):      # dates are only known once details are fetched; filter here too
        v["collections"] = [c for c in v["collections"] if c in colls and colls[c].wants("", v["upload_date"])]
        if v["collections"]:
            videos.append(v)
    log(f"Analysing {len(videos)} transcribed videos")

    (out / "data" / "words").mkdir(parents=True, exist_ok=True)
    (out / "data" / "transcripts").mkdir(parents=True, exist_ok=True)
    (out / "avatars").mkdir(parents=True, exist_ok=True)

    lexicon = {g: [text.phrase_tokens(t) for t in terms] for g, terms in text.LEXICON.items()}
    words = defaultdict(lambda: defaultdict(Counter))      # slug -> collection -> word counts
    bigrams = defaultdict(lambda: defaultdict(Counter))
    trigrams = defaultdict(lambda: defaultdict(Counter))
    totals = defaultdict(Counter)                          # slug -> collection -> tokens
    transcripts = defaultdict(dict)
    rows = []

    for v in videos:
        slug = v["hermit"]
        raw = text.clean(v["text"])
        toks = text.tokenize(raw)
        grams = text.ngram_index(toks, 3)
        lex = {}
        for g, terms in lexicon.items():
            counts = {" ".join(t): grams[t] for t in terms if grams[t]}
            if counts:
                lex[g] = counts
        spoken = finder.count(toks, skip=slug)
        title_mentions = sorted(set(finder.count(text.tokenize(v["title"] or ""), skip=slug)))

        uni = Counter(w for w in toks if text.interesting(w))
        bi = Counter({" ".join(g): c for g, c in grams.items()
                      if len(g) == 2 and text.interesting(g[0]) and text.interesting(g[1])})
        tri = Counter({" ".join(g): c for g, c in grams.items()
                       if len(g) == 3 and text.interesting(g[0]) and text.interesting(g[2])})
        for key in (*v["collections"], ALL):
            words[slug][key].update(uni)
            bigrams[slug][key].update(bi)
            trigrams[slug][key].update(tri)
            totals[slug][key] += len(toks)

        transcripts[slug][v["id"]] = _chunks(json.loads(v["segments"]))
        dur = v["duration"] or 0
        rows.append({
            "id": v["id"], "h": slug, "c": v["collections"], "t": v["title"], "d": _date(v["upload_date"]),
            "ts": v["timestamp"], "dur": round(dur), "v": v["view_count"], "l": v["like_count"],
            "cm": v["comment_count"], "ep": episode_number(v["title"]), "src": v["source"],
            "w": len(toks), "u": len(set(toks)), "r": text.mattr(toks),
            "wpm": round(len(toks) / (dur / 60), 1) if dur else None,
            "laugh": text.laughs(raw), "music": text.music_cues(raw),
            "m": dict(spoken), "tm": title_mentions, "lex": lex,
            "open": " ".join(toks[:14]), "close": " ".join(toks[-14:]),
        })

    present = sorted(words, key=lambda s: hermits[s].name.lower())
    everyone = defaultdict(Counter)                        # collection -> everyone's word counts
    for per_key in words.values():
        for key, counter in per_key.items():
            everyone[key].update(counter)
    for slug in present:
        doc = {}
        for key, counter in words[slug].items():
            rest = everyone[key] - counter
            own = {t for a in hermits[slug].aliases for t in text.phrase_tokens(a)}
            doc[key] = {
                "n": totals[slug][key],
                "w": counter.most_common(TOP_WORDS),
                "b": bigrams[slug][key].most_common(TOP_BIGRAMS),
                "t": trigrams[slug][key].most_common(TOP_TRIGRAMS),
                "x": [x for x in _distinctive(counter, rest, top=60) if x[0] not in own][:40] if rest else [],
            }
        (out / "data" / "words" / f"{slug}.json").write_text(json.dumps(doc, separators=(",", ":")))
        (out / "data" / "transcripts" / f"{slug}.json").write_text(
            json.dumps(transcripts[slug], separators=(",", ":")))

    avatars = {r["hermit"]: r["avatar_url"] for r in conn.execute("SELECT hermit, avatar_url FROM channels")}
    roster = []
    for h in cfg.hermits:
        has_avatar = _avatar(avatars.get(h.slug), out / "avatars" / f"{h.slug}.jpg")
        roster.append({"slug": h.slug, "name": h.name, "short": h.short, "url": h.url, "present": h.slug in words,
                       "avatar": f"avatars/{h.slug}.jpg" if has_avatar else None})

    meta = {
        "generated": int(time.time()),
        "site": cfg.site_url,
        "collections": [c.name for c in cfg.collections],
        "teams": {c.name: c.teams for c in cfg.collections if c.teams},
        "hermits": roster,
        "lexicon": text.LEXICON,
    }
    (out / "data" / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    (out / "data" / "videos.json").write_text(json.dumps(rows, separators=(",", ":")))

    for f in WEB.iterdir():
        if f.is_file():
            shutil.copy2(f, out / f.name)
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    return {"videos": len(rows), "hermits": len(present), "bytes": size}
