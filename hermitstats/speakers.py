"""Who's speaking when. Captions don't say, so every word in an episode used to count as the channel owner's.

Each episode's audio is cut into 1.5 s windows of speech, and each window gets a voiceprint (WeSpeaker ResNet34,
an open model run with onnxruntime). In their own episodes the owner is nearly always the main voice, so the
densest part of a Hermit's windows across their season is their voiceprint. Every window of every episode is then
matched to the nearest Hermit, or left unknown (a guest from outside the roster, music, a mob, or too little to
go on), and the caption words are split at the speaker changes.

Windows and per-word caption times stay in cache/voices/ (on the machine that ran it), so relabelling with better
voiceprints needs nothing from YouTube. The database gets one `speech` row per episode: the captions as
[start, end, speaker, text] runs, which is all the build needs."""

import json
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import yt_dlp

from .transcribe import _decode_audio
from .youtube import Cookies

MODEL_URL = "https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM/resolve/main/voxceleb_resnet34_LM.onnx"
SR = 16000
WIN, STEP = 150, 75            # fbank frames (10 ms): 1.5 s windows every 0.75 s
BATCH = 64


class Voices:
    """VAD + voiceprint per window; the model is downloaded once and loaded on first use."""

    def __init__(self, cache_dir: Path = Path("cache")):
        self.model_path = cache_dir / "models" / "wespeaker-resnet34-LM.onnx"
        self.audio_dir = cache_dir / "audio"
        self.dir = cache_dir / "voices"
        self.dir.mkdir(parents=True, exist_ok=True)
        self._session = None

    def _model(self):
        if self._session is None:
            import onnxruntime as ort
            if not self.model_path.exists():
                self.model_path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.model_path.with_suffix(".part")
                urllib.request.urlretrieve(MODEL_URL, tmp)
                tmp.rename(self.model_path)
            self._session = ort.InferenceSession(str(self.model_path), providers=["CPUExecutionProvider"])
        return self._session

    def has(self, video_id: str) -> bool:
        return (self.dir / f"{video_id}.npz").exists() and (self.dir / f"{video_id}.words.json").exists()

    def load(self, video_id: str) -> tuple[np.ndarray, np.ndarray, list]:
        d = np.load(self.dir / f"{video_id}.npz")
        words = json.loads((self.dir / f"{video_id}.words.json").read_text())
        return d["times"], d["embs"], words

    def download(self, video_id: str, source: str, language: str | None,
                 cookies: Cookies | None = None) -> tuple[Path, list]:
        """The episode's audio, and its caption words with their times (the same track the transcript came from)."""
        self.audio_dir.mkdir(parents=True, exist_ok=True)
        opts = {"quiet": True, "no_warnings": True, "noprogress": True,
                "format": "250/249/251/bestaudio",       # ~50 kbps opus is plenty for voices
                "outtmpl": str(self.audio_dir / "%(id)s.%(ext)s")}
        if cookies:
            opts.update(cookies.opts())
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)
            path = Path(ydl.prepare_filename(info))
            tracks = info.get("subtitles" if source == "manual-captions" else "automatic_captions") or {}
            fmt = next((f for f in tracks.get(language or "", []) if f.get("ext") == "json3"), None)
            words = caption_words(json.loads(ydl.urlopen(fmt["url"]).read().decode("utf-8"))) if fmt else []
        return path, words

    def embed(self, video_id: str, audio_path: Path, words: list) -> int:
        """Voiceprints for every speech window; saved next to the caption words. Returns the window count."""
        import kaldi_native_fbank as knf
        from faster_whisper.vad import VadOptions, get_speech_timestamps
        audio = _decode_audio(audio_path)
        opts = knf.FbankOptions()
        opts.frame_opts.dither = 0
        opts.frame_opts.samp_freq = SR
        opts.mel_opts.num_bins = 80
        times, feats = [], []
        for c in get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=300, speech_pad_ms=100)):
            if c["end"] - c["start"] < SR // 2:
                continue
            fb = knf.OnlineFbank(opts)
            fb.accept_waveform(SR, audio[c["start"]:c["end"]] * 32768)
            fb.input_finished()
            frames = np.array([fb.get_frame(i) for i in range(fb.num_frames_ready)], dtype=np.float32)
            for s in range(0, max(len(frames) - WIN, 0) + 1, STEP):
                w = frames[s:s + WIN]
                t = c["start"] / SR + s / 100
                times.append((t, t + len(w) / 100))
                if len(w) < WIN:                      # a short stretch of speech: repeat it to fill the window
                    w = np.resize(w, (WIN, 80))
                feats.append(w - w.mean(0))
        embs = np.zeros((0, 256), dtype=np.float32)
        if feats:
            model = self._model()
            embs = np.concatenate([model.run(None, {"feats": np.stack(feats[i:i + BATCH])})[0]
                                   for i in range(0, len(feats), BATCH)])
            embs /= np.linalg.norm(embs, axis=1, keepdims=True)
        np.savez(self.dir / f"{video_id}.npz", times=np.array(times, dtype=np.float32).reshape(-1, 2),
                 embs=embs.astype(np.float16))
        (self.dir / f"{video_id}.words.json").write_text(json.dumps(words, separators=(",", ":")))
        return len(times)


def caption_words(data: dict) -> list[list]:
    """[[second, text], ...] from a json3 caption track. Auto-captions time every word; a manual caption line
    only has its start and length, so its words are spread evenly across it."""
    out = []
    for ev in data.get("events", []):
        segs = [s for s in ev.get("segs") or [] if s.get("utf8", "").strip()]
        if not segs:
            continue
        start, dur = ev.get("tStartMs", 0), ev.get("dDurationMs", 0)
        if len(segs) == 1 and "tOffsetMs" not in segs[0]:
            parts = segs[0]["utf8"].replace("\n", " ").split()
            out += [[round((start + dur * i / len(parts)) / 1000, 2), p] for i, p in enumerate(parts)]
        else:
            out += [[round((start + s.get("tOffsetMs", 0)) / 1000, 2), s["utf8"].replace("\n", " ").strip()]
                    for s in segs]
    return out


# ---------------------------------------------------------------- who's who

MIN_SIM = 0.40       # below this a window matches nobody: unknown
OWNER_BONUS = 0.05   # in their own episode, a close call goes to the owner
SMOOTH = 2           # windows either side averaged in, so a voice doesn't flicker word to word
GAP = 2.0            # a word this far from any speech window keeps the owner (VAD missed it)


def voiceprint(embs: np.ndarray, keep: float = 0.5, rounds: int = 5) -> np.ndarray:
    """The densest part of a Hermit's windows in their own episodes, where they're nearly always the main voice:
    re-centre on the closest half a few times, so guests and noise drop out."""
    e = embs.astype(np.float32)
    c = e.mean(0)
    for _ in range(rounds):
        c /= np.linalg.norm(c)
        sim = e @ c
        c = e[sim >= np.quantile(sim, 1 - keep)].mean(0)
    return c / np.linalg.norm(c)


def voiceprints(own: dict[str, list[np.ndarray]]) -> dict[str, np.ndarray]:
    """slug -> voiceprint, from each Hermit's windows in their own episodes."""
    return {slug: voiceprint(np.concatenate(es)) for slug, es in own.items() if sum(len(e) for e in es) >= 200}


def label(embs: np.ndarray, prints: dict[str, np.ndarray], owner: str) -> list[str | None]:
    """The speaker of each window: a Hermit's slug, or None when the voice matches nobody."""
    if not len(embs) or not prints:
        return [None] * len(embs)
    names = list(prints)
    sim = embs.astype(np.float32) @ np.stack([prints[n] for n in names]).T
    k = 2 * SMOOTH + 1
    padded = np.pad(sim, ((SMOOTH, SMOOTH), (0, 0)), mode="edge")
    sim = np.lib.stride_tricks.sliding_window_view(padded, k, axis=0).mean(-1)
    if owner in prints:
        sim[:, names.index(owner)] += OWNER_BONUS
    best = sim.argmax(1)
    return [names[b] if sim[i, b] >= MIN_SIM else None for i, b in enumerate(best)]


def attribute(words: list, times: np.ndarray, labels: list, owner: str) -> list[list]:
    """Caption words joined into [start, end, speaker, text] runs, speaker None for an unknown voice.
    Each word goes to the window whose middle is nearest; with no speech window near it, to the owner."""
    if not words:
        return []
    if not len(times):
        return [[words[0][0], words[-1][0], owner, " ".join(w for _, w in words)]]
    mids = times.mean(1)
    out = []
    for t, w in words:
        i = int(np.clip(np.searchsorted(mids, t), 1, len(mids) - 1))
        i = i - 1 if abs(mids[i - 1] - t) <= abs(mids[i] - t) else i
        who = labels[i] if abs(mids[i] - t) <= GAP else owner
        if out and out[-1][2] == who:
            out[-1][1] = t
            out[-1][3] += " " + w
        else:
            out.append([t, t, who, w])
    return out


def airtime(times: np.ndarray, labels: list) -> dict[str, float]:
    """Seconds of speech per voice ('?' for unknown); windows overlap, so each counts for its step."""
    out = Counter()
    for (a, b), who in zip(times, labels):
        out[who or "?"] += min(float(b - a), STEP / 100)
    return {k: round(v, 1) for k, v in out.items()}


def relabel(conn, voices: Voices, videos: list[dict], log=print) -> int:
    """Voiceprints from everyone's own episodes, then a `speech` row for every episode with windows.
    `videos`: [{id, hermit}] for the episodes in scope. Returns how many were labelled."""
    from . import db
    own = defaultdict(list)
    cached = [v for v in videos if voices.has(v["id"])]
    for v in cached:
        own[v["hermit"]].append(voices.load(v["id"])[1])
    prints = voiceprints(own)
    del own
    log(f"voiceprints for {len(prints)} Hermits from {len(cached)} episodes")
    for v in cached:
        times, embs, words = voices.load(v["id"])
        labels = label(embs, prints, v["hermit"])
        db.save_speech(conn, v["id"], attribute(words, times, labels, v["hermit"]), airtime(times, labels))
    conn.commit()
    return len(cached)
