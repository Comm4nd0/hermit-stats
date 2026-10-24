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


def _chunks(segments: list[dict], owner: str | None = None) -> list[list]:
    """Merge caption segments into ~20 s [start, text] chunks (auto-captions repeat lines; drop repeats).
    Segments that know their speaker ("who") start a new chunk when the voice changes, and a chunk that isn't
    the owner's says whose it is: [start, text, slug], or "?" for a voice that matched no Hermit."""
    out, cur, start, last, who = [], [], None, None, owner

    def flush():
        out.append([int(start), " ".join(cur)] + ([who or "?"] if who != owner else []))

    for s in segments:
        t = text.clean(s["text"]).replace("[Music]", "").strip()
        if not t or t == last:
            continue
        last = t
        if cur and s.get("who", owner) != who:
            flush()
            cur, start = [], None
        who = s.get("who", owner)
        if start is None:
            start = s["start"]
        cur.append(t)
        if s["start"] - start >= CHUNK_SECONDS:
            flush()
            cur, start = [], None
    if cur:
        flush()
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
    """[[second, slug], ...] for every mention, timed by the caption segment it's in. When segments know their
    speaker, a mention by someone other than the owner (`skip`) says who: [second, slug, speaker or "?"]."""
    if not any("who" in s for s in segments):
        toks, times = [], []
        for s in segments:
            for t in text.tokenize(text.clean(s["text"])):
                toks.append(t)
                times.append(s["start"])
        return [[int(times[i]), slug] for i, slug in finder.find(toks, skip=skip)]
    out = []
    for s in segments:
        who = s["who"]
        for _, slug in finder.find(text.tokenize(text.clean(s["text"])), skip=who):
            out.append([int(s["start"]), slug] + ([who or "?"] if who != skip else []))
    return out


def split_speakers(v: dict, slug: str, hermits) -> tuple[str, dict[str, str], dict | None, list[dict]]:
    """(the owner's words, {guest Hermit: their words}, seconds of speech per voice, caption segments with
    their speaker). Without voice data every word is the owner's, as before; a voice that matched no Hermit
    is nobody's."""
    if not v.get("runs"):
        return v["text"], {}, None, json.loads(v["segments"])
    runs = json.loads(v["runs"])
    by = defaultdict(list)
    for _, _, who, said in runs:
        by[who].append(said)
    guests = {g: " ".join(t) for g, t in by.items() if g and g != slug and g in hermits}
    segments = [{"start": a, "end": b, "who": who, "text": said} for a, b, who, said in runs]
    return " ".join(by.get(slug, [])), guests, json.loads(v["airtime"]), segments


def conversations(segments: list[dict], hermits, gap: float = 5.0, near: float = 30.0
                  ) -> tuple[dict[str, int], dict[str, list[int]]]:
    """In voice-split segments: ({"a+b": times the talking passed between a and b}, {"a+b": [a's words,
    b's words] while they were talking to each other}). Passing means one Hermit answering the other within
    `gap` seconds, so a back-and-forth counts and a guest turning up an hour later doesn't. "Talking to each
    other" is within `near` seconds of a pass, so a long solo stretch either side doesn't count.
    Unknown voices are stepped over."""
    turns = [(s["who"], s["start"], s["end"], len(s["text"].split())) for s in segments if s.get("who") in hermits]
    sw, passes = Counter(), defaultdict(list)
    for (a, _, a_end, _), (b, b_start, _, _) in zip(turns, turns[1:]):
        if a != b and b_start - a_end <= gap:
            k = "+".join(sorted((a, b)))
            sw[k] += 1
            passes[k].append((a_end + b_start) / 2)
    talk = {}
    for k, ts in passes.items():
        spans = []                                 # the moments around each pass, overlapping ones merged
        for t in ts:
            if spans and t - near <= spans[-1][1]:
                spans[-1][1] = t + near
            else:
                spans.append([t - near, t + near])
        a, b = k.split("+")
        said = [0.0, 0.0]
        for who, start, end, n in turns:
            if who not in (a, b):
                continue
            if end > start:                        # a run's words are spread evenly over it
                share = sum(max(0, min(end, hi) - max(start, lo)) for lo, hi in spans) / (end - start)
            else:
                share = float(any(lo <= start <= hi for lo, hi in spans))
            said[who == b] += n * share
        talk[k] = [round(said[0]), round(said[1])]
    return dict(sw), talk


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
    """What the status page shows: the last sync run, every video still without a transcript, and episodes
    missing from their season playlist."""
    colls = {c.name: c for c in cfg.collections}
    waiting = []
    for r in db.waiting(conn):
        cs = [c for c in r["collections"] if c in colls and colls[c].wants("", r["upload_date"])]
        if cs:
            waiting.append({"id": r["id"], "h": r["hermit"], "c": cs, "t": r["title"], "d": _date(r["upload_date"]),
                            "why": reason(r["error"], r["details_at"]), "at": r["error_at"]})
    # Episodes missing from their creator's season playlist. A title that no longer matches the season was
    # probably renamed since it was imported, so it isn't listed as one.
    order = {c.name: i for i, c in enumerate(cfg.collections)}
    unlisted = [{"id": r["id"], "h": r["hermit"], "c": r["collection"], "t": r["title"], "d": _date(r["upload_date"])}
                for r in db.unlisted(conn) if r["collection"] in colls and r["upload_date"]
                and colls[r["collection"]].wants(r["title"], r["upload_date"])
                and colls[r["collection"]].video_title and colls[r["collection"]].video_title.search(r["title"] or "")]
    unlisted.sort(key=lambda u: order[u["c"]])
    return {"generated": int(time.time()), "sync": db.get_kv(conn, "last_sync"), "waiting": waiting,
            "unlisted": unlisted}


def teams(coll, hermits: dict, present: set) -> dict[str, list[str]]:
    """The collection's teams; outside Hermitcraft also its Hermits and its friends of the Hermits."""
    out = dict(coll.teams)
    if coll.series != "Hermitcraft":
        people = [s for s in coll.members if s in present]
        split = {"Hermits": [s for s in people if hermits[s].hermit],
                 "Friends of the Hermits": [s for s in people if not hermits[s].hermit]}
        if all(split.values()):
            out.update(split)
    return out


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
    """Write the site. One collection at a time, and within it one hermit at a time, so memory stays bounded
    however many seasons there are: each collection gets its own folder under data/."""
    finder = MentionFinder(cfg.hermits)
    hermits = {h.slug: h for h in cfg.hermits}
    colls = {c.name: c for c in cfg.collections}
    shutil.rmtree(out / "data", ignore_errors=True)     # a renamed hermit or season leaves no stale files
    (out / "avatars").mkdir(parents=True, exist_ok=True)
    lexicon = {g: [text.phrase_tokens(t) for t in terms] for g, terms in text.LEXICON.items()}
    seasons, week, counts = [], {}, defaultdict(lambda: defaultdict(Counter))   # counts: season -> slug -> source
    voiced = defaultdict(Counter)   # season -> {'split': episodes split by voice, 'all': episodes}
    present, total = set(), set()

    for coll in cfg.collections:
        dates = [d for d in db.upload_dates(conn, coll.name) if coll.wants("", d)]
        start = week_start(dates)
        if not start:
            continue        # no episodes yet: the season stays out of the picker
        log(f"{coll.name}: analysing {len(dates)} transcribed videos")
        base = out / "data" / coll.slug
        for d in ("words", "transcripts", "episodes"):
            (base / d).mkdir(parents=True, exist_ok=True)
        words, bigrams, trigrams = defaultdict(Counter), defaultdict(Counter), defaultdict(Counter)   # slug -> counts
        totals, spread, n_eps = Counter(), defaultdict(Counter), Counter()
        recent = Counter()                                     # words in the season's last week
        rows = []

        def finish(slug, transcripts, episodes, ep_words):
            """A hermit's videos are done: their standout words per episode, then their files."""
            season = words[slug]
            for vid, ep in episodes.items():
                freq, n = ep_words[vid]
                ep["x"] = _distinctive(freq, season, top=15, min_count=4, n_target=n) \
                    if sum(season.values()) > n else []
            (base / "transcripts" / f"{slug}.json").write_text(json.dumps(transcripts, separators=(",", ":")))
            (base / "episodes" / f"{slug}.json").write_text(json.dumps(episodes, separators=(",", ":")))

        slug = None
        transcripts, episodes, ep_words = {}, {}, {}
        for v in db.analysable(conn, coll.name):
            if not coll.wants("", v["upload_date"]):     # dates are only known once details are fetched
                continue
            if v["hermit"] != slug:
                if slug:
                    finish(slug, transcripts, episodes, ep_words)
                slug, transcripts, episodes, ep_words = v["hermit"], {}, {}, {}
            v["collections"] = [c for c in v["collections"] if c in colls and colls[c].wants("", v["upload_date"])]
            said, guests, air, segments = split_speakers(v, slug, hermits)
            raw = text.clean(said)
            toks = text.tokenize(raw)
            grams = text.ngram_index(toks, 3)
            lex = {}
            for g, terms in lexicon.items():
                found = {" ".join(t): grams[t] for t in terms if grams[t]}
                if found:
                    lex[g] = found
            spoken = finder.count(toks, skip=slug)
            title_mentions = sorted(set(finder.count(text.tokenize(v["title"] or ""), skip=slug)))

            uni = Counter(w for w in toks if text.interesting(w))
            bi = Counter({" ".join(g): c for g, c in grams.items()
                          if len(g) == 2 and text.interesting(g[0]) and text.interesting(g[1])})
            tri = Counter({" ".join(g): c for g, c in grams.items()
                           if len(g) == 3 and text.interesting(g[0]) and text.interesting(g[2])})
            words[slug].update(uni)
            bigrams[slug].update(bi)
            trigrams[slug].update(tri)
            totals[slug] += len(toks)
            spread[slug].update(bi.keys())
            spread[slug].update(tri.keys())
            n_eps[slug] += 1
            if (v["upload_date"] or "") >= start:
                recent.update(uni)
            ep_words[v["id"]] = (Counter({w: c for w, c in uni.items() if c >= 4}), sum(uni.values()))
            # Other Hermits heard in the episode: their words and phrases count as theirs, and so do the names they say.
            heard = {}
            for g, gsaid in guests.items():
                gt = text.tokenize(text.clean(gsaid))
                gg = text.ngram_index(gt, 3)
                gbi = Counter({" ".join(k): c for k, c in gg.items()
                               if len(k) == 2 and text.interesting(k[0]) and text.interesting(k[1])})
                gtri = Counter({" ".join(k): c for k, c in gg.items()
                                if len(k) == 3 and text.interesting(k[0]) and text.interesting(k[2])})
                words[g].update(w for w in gt if text.interesting(w))
                bigrams[g].update(gbi)
                trigrams[g].update(gtri)
                totals[g] += len(gt)
                spread[g].update(gbi.keys())
                spread[g].update(gtri.keys())
                heard[g] = {"w": len(gt), "m": dict(finder.count(gt, skip=g))}

            transcripts[v["id"]] = _chunks(segments, slug if air is not None else None)
            episodes[v["id"]] = {"mt": mention_times(finder, segments, slug)}
            counts[coll.name][slug][v["source"]] += 1
            voiced[coll.name]["all"] += 1
            voiced[coll.name]["split"] += air is not None
            total.add(v["id"])
            dur = v["duration"] or 0
            # Pace is the owner's words over the time others weren't talking.
            own_secs = max(dur - sum(t for g, t in (air or {}).items() if g in guests), dur / 5)
            sw, cv = conversations(segments, hermits) if air is not None else ({}, {})
            rows.append({
                "id": v["id"], "h": slug, "c": v["collections"], "t": v["title"], "d": _date(v["upload_date"]),
                "ts": v["timestamp"], "dur": round(dur), "v": v["view_count"], "l": v["like_count"],
                "cm": v["comment_count"], "ep": episode_number(v["title"]), "src": v["source"], "a": v["added_at"],
                "w": len(toks), "u": len(set(toks)), "r": text.mattr(toks),
                "wpm": round(len(toks) / (own_secs / 60), 1) if dur else None,
                "laugh": text.laughs(raw), "music": text.music_cues(text.clean(v["text"])),
                "m": dict(spoken), "tm": title_mentions, "lex": lex,
                "open": " ".join(toks[:14]), "close": " ".join(toks[-14:]),
                **({"sp": {k: round(t) for k, t in air.items()}, "g": heard, "sw": sw, "cv": cv} if air is not None else {}),
            })
        if slug:
            finish(slug, transcripts, episodes, ep_words)
        del transcripts, episodes, ep_words

        everyone, everyone_b, everyone_t = Counter(), Counter(), Counter()
        for s in words:
            everyone.update(words[s])
            everyone_b.update(bigrams[s])
            everyone_t.update(trigrams[s])
        for s in words:
            own = {t for a in hermits[s].aliases for t in text.phrase_tokens(a)}
            others = sum(everyone.values()) > sum(words[s].values())
            doc = {coll.name: {
                "n": totals[s],
                "w": words[s].most_common(TOP_WORDS),
                "b": bigrams[s].most_common(TOP_BIGRAMS),
                "t": trigrams[s].most_common(TOP_TRIGRAMS),
                "x": [x for x in _distinctive(words[s], everyone, top=60) if x[0] not in own][:40] if others else [],
                "p": catchphrases(bigrams[s], trigrams[s], everyone_b, everyone_t, own, spread[s], n_eps[s])
                if others else [],
            }}
            (base / "words" / f"{s}.json").write_text(json.dumps(doc, separators=(",", ":")))
        present.update(n_eps)          # their own episodes, not only heard in others'
        (base / "videos.json").write_text(json.dumps(rows, separators=(",", ":")))
        seasons.append({"name": coll.name, "slug": coll.slug, "series": coll.series})
        week[coll.name] = {"from": _date(start), "to": _date(max(dates)),
                           "words": [x for x in _distinctive(recent, everyone, top=15, min_count=10) if x[1] > 0]
                           if sum(everyone.values()) > sum(recent.values()) else []}

    avatars = {r["hermit"]: r["avatar_url"] for r in conn.execute("SELECT hermit, avatar_url FROM channels")}
    roster = []
    for h in cfg.hermits:
        has_avatar = _avatar(avatars.get(h.slug), out / "avatars" / f"{h.slug}.jpg")
        roster.append({"slug": h.slug, "name": h.name, "short": h.short, "url": h.url, "present": h.slug in present, "hermit": h.hermit,
                       "avatar": f"avatars/{h.slug}.jpg" if has_avatar else None})

    meta = {
        "generated": int(time.time()),
        "site": cfg.site_url,
        "collections": [s["name"] for s in seasons],
        "seasons": seasons,
        "teams": {c.name: teams(c, hermits, present) for c in cfg.collections if teams(c, hermits, present)},
        "hermits": roster,
        "lexicon": text.LEXICON,
        "week": week,
    }
    (out / "data" / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    st = status(conn, cfg)
    st["counts"] = counts          # season -> hermit -> transcript source -> episodes in the stats
    st["voices"] = {c: n for c, n in voiced.items() if n["split"]}   # seasons split by voice
    (out / "data" / "status.json").write_text(json.dumps(st, separators=(",", ":")))

    for f in WEB.iterdir():
        if f.is_file():
            shutil.copy2(f, out / f.name)
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    return {"videos": len(total), "hermits": len(present), "bytes": size}
