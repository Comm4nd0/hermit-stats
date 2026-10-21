"""Load hermits.toml: the roster, how to find each season's videos, and where to publish."""

import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Collection:
    name: str
    playlist: re.Pattern
    video_title: re.Pattern | None
    skip: re.Pattern | None = None
    starts: str | None = None          # YYYYMMDD; earlier uploads are never in the collection
    ends: str | None = None            # YYYYMMDD; nor are later ones
    series: str = "Hermitcraft"
    teams: dict[str, list[str]] = field(default_factory=dict)   # team name -> member slugs
    members: list[str] = field(default_factory=list)            # slugs; empty = every Hermit not `only_listed`

    @property
    def slug(self) -> str:
        return re.sub(r"[^a-z0-9]+", "-", self.name.lower()).strip("-")

    def wants(self, title: str, upload_date: str | None = None) -> bool:
        if self.skip and self.skip.search(title or ""):
            return False
        if not upload_date:
            return True
        return not (self.starts and upload_date < self.starts) and not (self.ends and upload_date > self.ends)

    def includes(self, hermit: "Hermit") -> bool:
        """Whether the hermit's channel is searched for this collection's videos."""
        return hermit.slug in self.members if self.members else not hermit.only_listed


@dataclass
class Hermit:
    name: str
    channel: str                       # @handle, bare channel id, or channel URL
    aliases: list[str]
    exclude: list[str] = field(default_factory=list)
    playlists: dict[str, str] = field(default_factory=dict)   # collection name -> playlist URL / id
    short: str = ""
    only_listed: bool = False          # a former Hermit or Life Series player: only in collections naming them
    hermit: bool = True                # played a Hermitcraft season; Life Series-only players are friends of the Hermits

    @property
    def slug(self) -> str:
        return re.sub(r"[^a-z0-9]+", "-", self.name.lower()).strip("-")

    @property
    def url(self) -> str:
        c = self.channel.strip()
        if c.startswith("http"):
            return c.rstrip("/")
        if c.startswith("UC") and len(c) == 24:
            return f"https://www.youtube.com/channel/{c}"
        return f"https://www.youtube.com/@{c.lstrip('@')}"


@dataclass
class Config:
    collections: list[Collection]
    hermits: list[Hermit]
    deploy_target: str | None
    site_url: str | None
    archive_channels: list[str] = field(default_factory=list)   # handles whose reuploads stay the hermit's

    def collection(self, name: str) -> Collection:
        for c in self.collections:
            if c.name.lower() == name.lower():
                return c
        raise LookupError(name)

    def hermit(self, query: str) -> Hermit:
        q = query.lower().lstrip("@")
        for h in self.hermits:
            if q in (h.slug, h.name.lower(), h.channel.lower().lstrip("@")):
                return h
        raise LookupError(query)


def load(path: Path) -> Config:
    raw = tomllib.loads(path.read_text())
    collections = [
        Collection(c["name"], re.compile(c["playlist"], re.I),
                   re.compile(c["video_title"], re.I) if c.get("video_title") else None,
                   re.compile(c["skip"], re.I) if c.get("skip") else None,
                   c["starts"].replace("-", "") if c.get("starts") else None,
                   c["ends"].replace("-", "") if c.get("ends") else None,
                   c.get("series", "Hermitcraft"))
        for c in raw.get("collection", [])
    ]
    hermits = [Hermit(h["name"], h["channel"], [a.lower() for a in h.get("aliases", [])],
                      [e.lower() for e in h.get("exclude", [])], h.get("playlists", {}), h.get("short") or h["name"],
                      h.get("only_listed", False))
               for h in raw.get("hermit", [])]
    deploy = raw.get("deploy", {})
    cfg = Config(collections, hermits, deploy.get("target"), deploy.get("url"),
                 [a.lower().lstrip("@") for a in raw.get("archive_channels", [])])
    for c, rc in zip(collections, raw.get("collection", [])):
        c.teams = {team: [cfg.hermit(m).slug for m in members] for team, members in rc.get("teams", {}).items()}
        c.members = [cfg.hermit(m).slug for m in rc.get("members", [])]
    for h in hermits:
        h.hermit = any(c.series == "Hermitcraft" and c.includes(h) for c in collections)
    return cfg
