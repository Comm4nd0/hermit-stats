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
from datetime import date, timedelta
from pathlib import Path

from . import db, text
from .config import Config
from .mentions import MentionFinder

WEB = Path(__file__).resolve().parent.parent / "web"
ALL = "*"           # words-file key for "every collection"
TOP_WORDS, TOP_BIGRAMS, TOP_TRIGRAMS = 1500, 600, 400
CHUNK_SECONDS = 20  # transcript search granularity
WEEK_DAYS = 7       # "words of the week": the last 7 days of uploads in a collection
# Sounds and hesitation, not phrases: one word repeated ("da da da") or only these ("mm hm mm").
NOISE = frozenset("mm hm hmm mhm um uh ah oh eh huh".split())

_EPISODE = re.compile(r"\bep(?:isode)?\.?\s*#?\s*(\d{1,3})\b", re.I)
_HASH = re.compile(r"#(\d{1,3})\b")


def episode_number(title: str) -> int | None:
    """"Ep 12" / "Episode #12" wins; otherwise the last "#12" (the first is often the season: "Hermitcraft #11 #4")."""
    m = _EPISODE.search(title or "")
    if m:
        return int(m.group(1))
    hashes = _HASH.findall(title or "")
    return int(hashes[-1]) if hashes else None


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


def _distinctive(target: Counter, total: Counter, top: int = 40, min_count: int = 8,
                 n_target: int | None = None) -> list:
    """Words a Hermit uses far more than everyone else: log-odds ratio with an informative Dirichlet
    prior (Monroe et al. 2008), as z-scores. Robust to very different amounts of footage.
    `total` includes `target` (the rest is total - target). `n_target` is target's size when only its
    frequent words were kept."""
    a0 = sum(total.values()) or 1
    n1 = n_target or sum(target.values()) or 1
    n2 = max(1, a0 - n1)
    scale = 500 / a0      # prior strength: a modest pseudo-corpus shaped like the whole collection
    a_sum = 500
    out = []
    for w, y1 in target.items():
        if y1 < min_count:
            continue
        a = total[w] * scale
        y2 = max(0, total[w] - y1)
        if n1 + a_sum - y1 - a <= 0 or n2 + a_sum - y2 - a <= 0:
            continue      # the word is the whole corpus: no odds to compare
        d = (math.log((y1 + a) / (n1 + a_sum - y1 - a)) - math.log((y2 + a) / (n2 + a_sum - y2 - a)))
        var = 1 / (y1 + a) + 1 / (y2 + a)
        out.append((w, round(d / math.sqrt(var), 2), y1))
    out.sort(key=lambda x: -x[1])
    return [list(x) for x in out[:top]]


def is_noise(phrase: str) -> bool:
    ws = phrase.split()
    return len(set(ws)) == 1 or all(w in NOISE for w in ws)


# Words that make a phrase a Minecraft topic ("bone meal", "copper golem"), a show intro everyone has
# ("another episode of hermitcraft") or counting, rather than a Hermit's own way of talking.
TOPIC_WORDS = frozenset(w for g in ("Mobs", "Materials", "Redstone & tech") for t in text.LEXICON[g]
                        for w in text.phrase_tokens(t)) | frozenset("""
    block blocks chest chests box boxes farm wood logs base build moss meal oak slate wool concrete
    hermitcraft season server episode episodes video videos
    three four five six seven eight nine ten eleven twelve""".split())


def catchphrases(bi: Counter, tri: Counter, bi_total: Counter, tri_total: Counter, own: set[str],
                 spread: Counter, episodes: int, top: int = 12, min_count: int = 10, min_z: float = 4.0) -> list:
    """A Hermit's habits of speech: two- and three-word phrases they say far more than the others (z of at
    least `min_z`), ranked by how many of their episodes they're in (`spread`), so a sign-off said every
    episode beats a build project talked about for a month. [[phrase, z, times said, episodes], ...]
    Sounds, Minecraft topics, their own name, and phrases inside (or around) one already picked are left
    out, so "hello and welcome" doesn't also give "and welcome"."""
    def habits(grams):
        return Counter({p: c for p, c in grams.items() if c >= min_count and spread[p] >= 3
                        and not TOPIC_WORDS.intersection(p.split())})
    cands = (_distinctive(habits(bi), bi_total, top=400, min_count=min_count, n_target=sum(bi.values()))
             + _distinctive(habits(tri), tri_total, top=400, min_count=min_count, n_target=sum(tri.values())))
    cands = [[p, z, c, spread[p]] for p, z, c in cands if z >= min_z]
    cands.sort(key=lambda x: (-x[3], -x[1]))
    out = []
    for phrase, z, c, n in cands:
        if is_noise(phrase) or set(phrase.split()) <= own:
            continue
        if any(f" {phrase} " in f" {q} " or f" {q} " in f" {phrase} " for q, *_ in out):
            continue
        out.append([phrase, z, c, n])
        if len(out) == top:
            break
    return out


def mention_times(finder: MentionFinder, segments: list[dict], skip: str) -> list[list]:
    """[[second, slug], ...] for every mention, timed by the caption segment it's in."""
    toks, times = [], []
    for s in segments:
        for t in text.tokenize(text.clean(s["text"])):
            toks.append(t)
            times.append(s["start"])
    return [[int(times[i]), slug] for i, slug in finder.find(toks, skip=skip)]


def week_start(upload_dates: list[str]) -> str | None:
    """YYYYMMDD of the first day of the last WEEK_DAYS days that have uploads."""
    if not upload_dates:
        return None
    end = max(upload_dates)
    d = date(int(end[:4]), int(end[4:6]), int(end[6:8])) - timedelta(days=WEEK_DAYS - 1)
    return d.strftime("%Y%m%d")


def reason(error: str | None, details_at: int | None) -> str:
    """Why a video has no transcript yet, in words for the status page (never the raw error, which can
    carry local paths)."""
    if not error:
        return "Queued for the next run"
    if error == "whisper-wait":
        return "Waiting for Whisper"
    if error == "no-transcript":
        return "No captions, no Whisper transcript"
    e = error.lower()
    for keys, label in ((("not a bot",), "YouTube bot check"),
                        (("premiere", "live event", "will begin"), "Premiere not started"),
                        (("members",), "Members-only"),
                        (("private",), "Private video"),
                        (("confirm your age", "age-restricted", "inappropriate"), "Age-restricted"),
                        (("unavailable", "removed", "terminated", "does not exist"), "Unavailable")):
        if any(k in e for k in keys):
            return label
    return "Fetch failed"


def status(conn, cfg: Config) -> dict:
    """What the status page shows: the last sync run and every video still without a transcript."""
    colls = {c.name: c for c in cfg.collections}
    waiting = []
    for r in db.waiting(conn):
        cs = [c for c in r["collections"] if c in colls and colls[c].wants("", r["upload_date"])]
        if cs:
            waiting.append({"id": r["id"], "h": r["hermit"], "c": cs, "t": r["title"], "d": _date(r["upload_date"]),
                            "why": reason(r["error"], r["details_at"]), "at": r["error_at"]})
    return {"generated": int(time.time()), "sync": db.get_kv(conn, "last_sync"), "waiting": waiting}


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
    (out / "data" / "episodes").mkdir(parents=True, exist_ok=True)
    (out / "avatars").mkdir(parents=True, exist_ok=True)

    lexicon = {g: [text.phrase_tokens(t) for t in terms] for g, terms in text.LEXICON.items()}
    words = defaultdict(lambda: defaultdict(Counter))      # slug -> collection -> word counts
    bigrams = defaultdict(lambda: defaultdict(Counter))
    trigrams = defaultdict(lambda: defaultdict(Counter))
    totals = defaultdict(Counter)                          # slug -> collection -> tokens
    spread = defaultdict(lambda: defaultdict(Counter))     # slug -> collection -> episodes each phrase is in
    n_eps = defaultdict(Counter)                           # slug -> collection -> episodes
    transcripts = defaultdict(dict)
    episodes = defaultdict(dict)                           # slug -> video id -> timeline, standout words
    ep_words = {}                                          # video id -> (frequent words, word count, collection)
    starts = {c: week_start([v["upload_date"] for v in videos if c in v["collections"] and v["upload_date"]])
              for c in colls}
    recent = defaultdict(Counter)                          # collection -> words in its last week
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
            spread[slug][key].update(bi.keys())
            spread[slug][key].update(tri.keys())
            n_eps[slug][key] += 1
        for c in v["collections"]:
            if starts[c] and (v["upload_date"] or "") >= starts[c]:
                recent[c].update(uni)
        ep_words[v["id"]] = (Counter({w: c for w, c in uni.items() if c >= 4}), sum(uni.values()), v["collections"][0])

        segments = json.loads(v["segments"])
        transcripts[slug][v["id"]] = _chunks(segments)
        episodes[slug][v["id"]] = {"mt": mention_times(finder, segments, slug)}
        dur = v["duration"] or 0
        rows.append({
            "id": v["id"], "h": slug, "c": v["collections"], "t": v["title"], "d": _date(v["upload_date"]),
            "ts": v["timestamp"], "dur": round(dur), "v": v["view_count"], "l": v["like_count"],
            "cm": v["comment_count"], "ep": episode_number(v["title"]), "src": v["source"], "a": v["added_at"],
            "w": len(toks), "u": len(set(toks)), "r": text.mattr(toks),
            "wpm": round(len(toks) / (dur / 60), 1) if dur else None,
            "laugh": text.laughs(raw), "music": text.music_cues(raw),
            "m": dict(spoken), "tm": title_mentions, "lex": lex,
            "open": " ".join(toks[:14]), "close": " ".join(toks[-14:]),
        })

    present = sorted(words, key=lambda s: hermits[s].name.lower())
    everyone = defaultdict(Counter)                        # collection -> everyone's word / phrase counts
    everyone_b, everyone_t = defaultdict(Counter), defaultdict(Counter)
    for slug in present:
        for key in words[slug]:
            everyone[key].update(words[slug][key])
            everyone_b[key].update(bigrams[slug][key])
            everyone_t[key].update(trigrams[slug][key])
    for slug in present:
        doc = {}
        own = {t for a in hermits[slug].aliases for t in text.phrase_tokens(a)}
        for key, counter in words[slug].items():
            others = sum(everyone[key].values()) > sum(counter.values())
            doc[key] = {
                "n": totals[slug][key],
                "w": counter.most_common(TOP_WORDS),
                "b": bigrams[slug][key].most_common(TOP_BIGRAMS),
                "t": trigrams[slug][key].most_common(TOP_TRIGRAMS),
                "x": [x for x in _distinctive(counter, everyone[key], top=60) if x[0] not in own][:40] if others else [],
                "p": catchphrases(bigrams[slug][key], trigrams[slug][key], everyone_b[key], everyone_t[key], own,
                                  spread[slug][key], n_eps[slug][key]) if others else [],
            }
        # Each episode's standout words: against the Hermit's other episodes in its (first) collection.
        for vid, ep in episodes[slug].items():
            freq, n, coll = ep_words[vid]
            season = words[slug][coll]
            ep["x"] = _distinctive(freq, season, top=15, min_count=4, n_target=n) \
                if sum(season.values()) > n else []
        (out / "data" / "words" / f"{slug}.json").write_text(json.dumps(doc, separators=(",", ":")))
        (out / "data" / "transcripts" / f"{slug}.json").write_text(
            json.dumps(transcripts[slug], separators=(",", ":")))
        (out / "data" / "episodes" / f"{slug}.json").write_text(json.dumps(episodes[slug], separators=(",", ":")))

    avatars = {r["hermit"]: r["avatar_url"] for r in conn.execute("SELECT hermit, avatar_url FROM channels")}
    roster = []
    for h in cfg.hermits:
        has_avatar = _avatar(avatars.get(h.slug), out / "avatars" / f"{h.slug}.jpg")
        roster.append({"slug": h.slug, "name": h.name, "short": h.short, "url": h.url, "present": h.slug in words, "guest": h.guest,
                       "avatar": f"avatars/{h.slug}.jpg" if has_avatar else None})

    meta = {
        "generated": int(time.time()),
        "site": cfg.site_url,
        "collections": [c.name for c in cfg.collections if starts[c.name]],    # one with no episodes yet stays hidden
        "teams": {c.name: c.teams for c in cfg.collections if c.teams},
        "hermits": roster,
        "lexicon": text.LEXICON,
        "week": {c: {"from": _date(starts[c]), "to": _date(max(v["upload_date"] for v in videos
                                                              if c in v["collections"] and v["upload_date"])),
                     "words": [x for x in _distinctive(recent[c], everyone[c], top=15, min_count=10) if x[1] > 0]
                     if sum(everyone[c].values()) > sum(recent[c].values()) else []}
                 for c in colls if starts[c]},
    }
    (out / "data" / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    (out / "data" / "videos.json").write_text(json.dumps(rows, separators=(",", ":")))
    (out / "data" / "status.json").write_text(json.dumps(status(conn, cfg), separators=(",", ":")))

    for f in WEB.iterdir():
        if f.is_file():
            shutil.copy2(f, out / f.name)
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    return {"videos": len(rows), "hermits": len(present), "bytes": size}
