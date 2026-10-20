"""Get a transcript for a video: YouTube captions first, local Whisper as fallback."""

import ctypes
import json
import re
import subprocess
import sys
from pathlib import Path

import yt_dlp

from .youtube import Cookies


def _pick_track(tracks: dict, lang: str) -> tuple[str, list] | None:
    """Pick the best caption track for `lang` from a yt-dlp subtitles dict.
    Prefers the original-language auto track ('en-orig') over machine translations."""
    if not tracks:
        return None
    for key in (f"{lang}-orig", lang):
        if key in tracks:
            return key, tracks[key]
    for key, formats in tracks.items():          # regional variants: en-GB, en-US...
        if re.fullmatch(rf"{re.escape(lang)}(-[A-Za-z]+)?", key):
            return key, formats
    return None


def _parse_json3(data: dict) -> list[dict]:
    segments = []
    for ev in data.get("events", []):
        if "segs" not in ev:
            continue
        text = "".join(s.get("utf8", "") for s in ev["segs"]).replace("\n", " ").strip()
        if not text:
            continue
        start = ev.get("tStartMs", 0) / 1000
        segments.append({"start": start, "end": start + ev.get("dDurationMs", 0) / 1000, "text": text})
    return segments


def from_captions(info: dict, lang: str = "en", allow_auto: bool = True) -> tuple[str, str, list[dict]] | None:
    """Return (source, language, segments) from YouTube captions, or None if unavailable."""
    candidates = [("manual-captions", info.get("subtitles") or {})]
    if allow_auto:
        candidates.append(("auto-captions", info.get("automatic_captions") or {}))
    for source, tracks in candidates:
        picked = _pick_track(tracks, lang)
        if not picked:
            continue
        key, formats = picked
        fmt = next((f for f in formats if f.get("ext") == "json3"), None)
        if not fmt:
            continue
        with yt_dlp.YoutubeDL({"quiet": True}) as ydl:
            data = json.loads(ydl.urlopen(fmt["url"]).read().decode("utf-8"))
        segments = _parse_json3(data)
        if segments:
            return source, key, segments
    return None


def _preload_cuda_libs() -> None:
    """ctranslate2 wheels link against CUDA 12 cuBLAS/cuDNN. Load the pip-installed copies
    (nvidia-cublas-cu12 / nvidia-cudnn-cu12) globally so they're found whatever CUDA the system has."""
    try:
        import nvidia.cublas, nvidia.cudnn
    except ImportError:
        return
    libs = [p for pkg in (nvidia.cublas, nvidia.cudnn) for d in pkg.__path__
            for p in sorted(Path(d, "lib").glob("lib*.so*"))]
    # Some libs depend on others in the list; retry until no further progress.
    while libs:
        failed = []
        for lib in libs:
            try:
                ctypes.CDLL(str(lib), mode=ctypes.RTLD_GLOBAL)
            except OSError:
                failed.append(lib)
        if len(failed) == len(libs):
            return
        libs = failed


def _decode_audio(path: Path, sr: int = 16000):
    """Decode to 16 kHz mono float32 with ffmpeg (sidesteps PyAV version breakage)."""
    import numpy as np
    out = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(sr), "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(out, dtype=np.float32)


def _probe_audio():
    """30 s of faint noise: one full encoder window, so a probe needs as much VRAM as real audio."""
    import numpy as np
    return (np.random.default_rng(0).standard_normal(16000 * 30) * 0.01).astype(np.float32)


class Whisper:
    """Lazy-loaded faster-whisper model, reused across videos."""

    def __init__(self, model: str = "large-v3-turbo", device: str = "auto", cache_dir: Path = Path("cache")):
        self.model_name = model
        self.device = device
        self.audio_dir = cache_dir / "audio"
        self._model = None

    def _load(self):
        if self._model is None:
            from faster_whisper import WhisperModel
            if self.device != "cpu":
                _preload_cuda_libs()
                # int8_float16 needs roughly half the VRAM, for when an LLM is hogging the GPU.
                for compute in ("float16", "int8_float16"):
                    try:
                        model = WhisperModel(self.model_name, device="cuda", compute_type=compute)
                        # CUDA libs load lazily, so a bad setup only shows up on first encode.
                        list(model.transcribe(_probe_audio(), vad_filter=False)[0])
                        self._model = model
                        break
                    except (RuntimeError, ValueError) as e:
                        err = e
                if self._model is None:
                    if self.device == "cuda":
                        raise err
                    self._use_cpu(err)
            else:
                self._model = WhisperModel(self.model_name, device="cpu", compute_type="int8")
        return self._model

    def _use_cpu(self, reason) -> None:
        from faster_whisper import WhisperModel
        print(f"\nwarning: GPU unusable ({reason}); using CPU, this will be slow", file=sys.stderr)
        self.device = "cpu"
        self._model = WhisperModel(self.model_name, device="cpu", compute_type="int8")

    @staticmethod
    def _run(model, audio, lang=None):
        segs, info = model.transcribe(audio, language=lang, vad_filter=True)
        return [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in segs], info

    def download_audio(self, video_id: str, cookies: Cookies | None = None) -> Path:
        self.audio_dir.mkdir(parents=True, exist_ok=True)
        existing = list(self.audio_dir.glob(f"{video_id}.*"))
        if existing:
            return existing[0]
        opts = {
            "quiet": True, "no_warnings": True, "noprogress": True,
            "format": "bestaudio/best",
            "outtmpl": str(self.audio_dir / "%(id)s.%(ext)s"),
        }
        if cookies:
            opts.update(cookies.opts())
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)
            return Path(ydl.prepare_filename(info))

    def transcribe(self, video_id: str, lang: str | None = "en", keep_audio: bool = False,
                   cookies: Cookies | None = None) -> tuple[str, str, list[dict]]:
        audio = self.download_audio(video_id, cookies)
        try:
            samples = _decode_audio(audio)
            try:
                segments, info = self._run(self._load(), samples, lang)
            except RuntimeError as e:
                if "out of memory" not in str(e) or self.device == "cuda":
                    raise
                self._use_cpu(e)      # VRAM got taken mid-run; finish on CPU rather than fail
                segments, info = self._run(self._model, samples, lang)
        finally:
            if not keep_audio:
                audio.unlink(missing_ok=True)
        return "whisper", info.language, segments
