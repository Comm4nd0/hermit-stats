import json
import sqlite3
from collections import Counter

from hermitstats import build, db, text
from hermitstats.config import Collection, Config, Hermit
from hermitstats.mentions import MentionFinder
import re

HERMITS = [
    Hermit("PearlescentMoon", "@PearlescentMoon", ["pearl", "pearlescent moon"], ["ender pearl", "ender pearls"]),
    Hermit("Mumbo Jumbo", "@ThatMumboJumbo", ["mumbo", "mumbo jumbo"]),
    Hermit("Grian", "@Grian", ["grian"]),
    Hermit("GoodTimesWithScar", "@GoodTimesWithScar", ["scar", "good times with scar"], ["scarred"]),
]


def find(s, skip=None):
    return MentionFinder(HERMITS).find(text.tokenize(s), skip=skip)


# ---------------------------------------------------------------- mentions

def test_adjacent_and_punctuated_mentions():
    assert [s for _, s in find("Grian, Mumbo! Pearl?")] == ["grian", "mumbo-jumbo", "pearlescentmoon"]


def test_multi_word_alias_spans_punctuation_and_case():
    assert [s for _, s in find("GOOD TIMES, with Scar")] == ["goodtimeswithscar"]


def test_exclude_only_blocks_its_own_tokens():
    # "ender pearl" is blocked, but the Pearl right after it is still a mention
    assert [s for _, s in find("an ender pearl for pearl")] == ["pearlescentmoon"]
    assert find("scarred for life, scar") == [(3, "goodtimeswithscar")]


def test_skipped_speaker_alias_is_consumed_not_split():
    # Mumbo saying "mumbo jumbo" isn't a mention, and its second word doesn't start a new match
    assert find("mumbo jumbo here", skip="mumbo-jumbo") == []


def test_possessives_are_not_names():
    # tokenize keeps "grian's" as one token, which isn't an alias: a known undercount, pinned here
    assert find("grian's base") == []


# ---------------------------------------------------------------- episode numbers

def test_episode_number_prefers_explicit_episode_over_season_hash():
    assert build.episode_number("Hermitcraft #11: Episode 4") == 4
    assert build.episode_number("Hermitcraft 11 #11 #4") == 4
    assert build.episode_number("HERMITCRAFT 11 EP.7 - Mega Base") == 7
    assert build.episode_number("Episode #9: The End") == 9


def test_episode_number_ignores_numbers_in_words():
    assert build.episode_number("100 Days of Hermitcraft") is None
    assert build.episode_number("Deep 3 epic builds") is None


# ---------------------------------------------------------------- text helpers used by the build

def test_chunks_merge_and_drop_repeats():
    segs = [{"start": 0, "text": "hello"}, {"start": 1, "text": "hello"}, {"start": 5, "text": "there"},
            {"start": 25, "text": "[Music]"}, {"start": 30, "text": "bye"}, {"start": 31, "text": "now"}]
    # a chunk ends with the first segment 20 s or more after it started
    assert build._chunks(segs) == [[0, "hello there bye"], [31, "now"]]


def test_distinctive_finds_the_overused_word():
    me = Counter({"redstone": 50, "build": 50})
    total = me + Counter({"redstone": 5, "build": 500})
    words = [w for w, z, c in build._distinctive(me, total, min_count=1)]
    assert words[0] == "redstone"


def test_distinctive_n_target_lets_rare_words_be_dropped():
    full = Counter({"goat": 20, **{f"w{i}": 1 for i in range(400)}})
    total = full + Counter({"goat": 2, "cow": 2000})
    trimmed = Counter({"goat": 20})
    assert build._distinctive(trimmed, total, min_count=4, n_target=sum(full.values())) \
        == build._distinctive(full, total, min_count=4)


def test_noise_phrases():
    assert build.is_noise("da da da") and build.is_noise("mm hm") and not build.is_noise("oh no")


def test_catchphrases_prefer_habits_over_topics():
    # 10 episodes: a sign-off in all of them, a project phrase in 3, a Minecraft topic in all
    bi, spread = Counter(), Counter()
    for ep in range(10):
        for p, c in (("good one", 2), ("bone meal", 5)) + ((("pulse extender", 10),) if ep < 3 else ()):
            bi[p] += c
            spread[p] += 1
    others = Counter({"good one": 1, "bone meal": 10, "pulse extender": 1, "the end": 5000})
    tri = Counter({"good one everyone": 15})
    spread["good one everyone"] = 8
    got = build.catchphrases(bi, tri, bi + others, tri + Counter({"good one everyone": 1}), own=set(),
                             spread=spread, episodes=10, min_count=5)
    phrases = [p for p, *_ in got]
    assert phrases[0] == "good one"           # in every episode
    assert "good one everyone" not in phrases  # contains one already picked
    assert "bone meal" not in phrases          # a Minecraft topic
    assert phrases.index("pulse extender") > 0


def test_catchphrases_skip_own_name():
    bi = Counter({"mumbo jumbo": 50})
    got = build.catchphrases(bi, Counter(), bi + Counter({"other": 1000}), Counter(), own={"mumbo", "jumbo"},
                             spread=Counter({"mumbo jumbo": 10}), episodes=10)
    assert got == []


def test_mention_times_follow_segments():
    segs = [{"start": 0.0, "text": "hi"}, {"start": 61.5, "text": "where's Mumbo"}, {"start": 90, "text": "and Grian"}]
    assert build.mention_times(MentionFinder(HERMITS), segs, skip="grian") == [[61, "mumbo-jumbo"]]


def test_week_start():
    assert build.week_start(["20261001", "20261018", "20261012"]) == "20261012"
    assert build.week_start(["20260301"]) == "20260223"   # across a month end
    assert build.week_start([]) is None


def test_reason_never_shows_raw_errors():
    assert build.reason(None, None) == "Queued for the next run"
    assert build.reason("whisper-wait", 1) == "Waiting for Whisper"
    assert build.reason("ERROR: [youtube] x: Sign in to confirm you're not a bot", 1) == "YouTube bot check"
    assert build.reason("ERROR: Premieres in 3 hours", 1) == "Premiere not started"
    assert build.reason("ERROR: Join this channel to get access to members-only content", 1) == "Members-only"
    assert build.reason("ffmpeg failed on /home/hermit/cache/x.m4a", 1) == "Fetch failed"


# ---------------------------------------------------------------- database

def test_connect_adds_new_columns_to_an_old_database(tmp_path):
    path = tmp_path / "old.db"
    old = sqlite3.connect(path)
    old.executescript("""CREATE TABLE videos (id TEXT PRIMARY KEY, channel TEXT NOT NULL, title TEXT);
                         CREATE TABLE transcripts (video_id TEXT PRIMARY KEY, source TEXT NOT NULL, language TEXT,
                                                   text TEXT NOT NULL, segments TEXT NOT NULL);""")
    old.close()
    conn = db.connect(path)
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(videos)")}
    assert {"error", "error_at"} <= cols
    assert "added_at" in {r["name"] for r in conn.execute("PRAGMA table_info(transcripts)")}


def test_errors_are_cleared_by_a_transcript(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    db.upsert_video(conn, "UC1", {"id": "v1", "title": "t"})
    db.set_error(conn, "v1", "whisper-wait")
    assert conn.execute("SELECT error FROM videos").fetchone()[0] == "whisper-wait"
    db.save_transcript(conn, "v1", "auto-captions", "en", [{"start": 0, "end": 1, "text": "hi"}])
    row = conn.execute("SELECT v.error, t.added_at FROM videos v JOIN transcripts t ON t.video_id = v.id").fetchone()
    assert row[0] is None and row[1] > 0


# ---------------------------------------------------------------- the whole build, on a tiny season

def _video(conn, vid, channel, title, date, said):
    db.upsert_video(conn, channel, {"id": vid, "title": title, "upload_date": date, "duration": 600,
                                    "view_count": 1000, "like_count": 50, "timestamp": 0})
    db.add_to_collection(conn, "Season 11", vid, "title")
    db.save_transcript(conn, vid, "auto-captions", "en",
                       [{"start": 20.0 * i, "end": 20.0 * i + 5, "text": line} for i, line in enumerate(said)])


def test_build_writes_every_data_file(tmp_path):
    hermits = HERMITS[1:3]
    cfg = Config([Collection("Season 11", re.compile("x"), None, None, "20251101")], hermits, None, "https://example.test")
    conn = db.connect(tmp_path / "t.db")
    db.upsert_channel(conn, "UCm", "mumbo-jumbo", "Mumbo", hermits[0].url, None)
    db.upsert_channel(conn, "UCg", "grian", "Grian", hermits[1].url, None)
    for i in range(4):
        _video(conn, f"m{i}", "UCm", f"Hermitcraft 11 Ep {i + 1}", f"2026100{i + 1}",
               ["hello hermits welcome back", "redstone redstone piston", "grian is pranking me", "time to start"] * 5)
        _video(conn, f"g{i}", "UCg", f"Hermitcraft 11: Episode {i + 1}", f"2026100{i + 1}",
               ["hello and welcome", "mumbo mumbo mumbo", "black concrete everywhere", "good bye"] * 5)
    db.upsert_video(conn, "UCg", {"id": "late", "title": "Hermitcraft 11 Ep 5", "upload_date": "20261006"})
    db.add_to_collection(conn, "Season 11", "late", "title")
    db.set_error(conn, "late", "whisper-wait")
    db.set_kv(conn, "last_sync", {"started": 1, "finished": 2})
    conn.commit()

    out = tmp_path / "site"
    r = build.build(conn, cfg, out, log=lambda *a: None)
    assert r == {"videos": 8, "hermits": 2, "bytes": r["bytes"]}

    meta = json.loads((out / "data" / "meta.json").read_text())
    assert meta["week"]["Season 11"]["from"] == "2026-09-28" and meta["week"]["Season 11"]["to"] == "2026-10-04"

    videos = {v["id"]: v for v in json.loads((out / "data" / "videos.json").read_text())}
    assert videos["m0"]["ep"] == 1 and videos["m0"]["m"] == {"grian": 5} and videos["m0"]["a"] > 0
    assert videos["g0"]["m"] == {"mumbo-jumbo": 15}

    eps = json.loads((out / "data" / "episodes" / "grian.json").read_text())
    assert eps["g0"]["mt"][:3] == [[20, "mumbo-jumbo"]] * 3

    words = json.loads((out / "data" / "words" / "mumbo-jumbo.json").read_text())["Season 11"]
    assert "redstone" in [w for w, *_ in words["x"]]
    assert isinstance(words["p"], list)    # too little speech here for any phrase to clear min_z

    status = json.loads((out / "data" / "status.json").read_text())
    assert status["sync"] == {"started": 1, "finished": 2}
    assert [(w["id"], w["why"]) for w in status["waiting"]] == [("late", "Waiting for Whisper")]
    assert (out / "index.html").exists() and (out / "app.js").exists()


def test_discovery_never_holds_a_write_across_youtube_requests(tmp_path, monkeypatch):
    from hermitstats import cli, youtube
    conn = db.connect(tmp_path / "t.db")
    calls = []

    def request(result):
        def fake(*a, **k):
            calls.append(conn.in_transaction)
            return result
        return fake
    vids = [{"id": f"v{i}", "title": f"Hermitcraft 11 Ep {i}", "upload_date": "20260101"} for i in range(3)]
    monkeypatch.setattr(youtube, "channel_playlists", request(
        {"id": "UCg", "name": "Grian", "avatar_url": None,
         "playlists": [("PL1", "Hermitcraft 11"), ("PL2", "Hermitcraft Season 11 part 2")]}))
    monkeypatch.setattr(youtube, "list_playlist", request(vids))
    monkeypatch.setattr(youtube, "list_uploads", request(vids + [{"id": "new", "title": "Hermitcraft 11 Ep 9", "upload_date": "20260102"}]))
    pattern = re.compile(r"hermitcraft.*11", re.I)
    cfg = Config([Collection("Season 11", pattern, pattern), Collection("Season 11b", pattern, pattern)],
                 [HERMITS[2]], None, None)
    assert cli._discover(conn, cfg, HERMITS[2], None) == 8
    assert len(calls) == 6 and not any(calls)     # no uncommitted write while YouTube was asked
    assert not conn.in_transaction
