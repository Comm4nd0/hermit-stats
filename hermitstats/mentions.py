"""Find Hermits' names in a token stream."""

from collections import Counter

from . import text
from .config import Hermit


class MentionFinder:
    def __init__(self, hermits: list[Hermit]):
        # first token -> [(alias tokens, slug)], longest alias first so "mumbo jumbo" beats "mumbo"
        self._by_first: dict[str, list[tuple[tuple[str, ...], str]]] = {}
        self._exclude: dict[str, list[tuple[str, ...]]] = {}
        for h in hermits:
            for a in h.aliases:
                toks = text.phrase_tokens(a)
                if toks:
                    self._by_first.setdefault(toks[0], []).append((toks, h.slug))
            for e in h.exclude:
                toks = text.phrase_tokens(e)
                if toks:
                    self._exclude.setdefault(toks[0], []).append(toks)
        for lst in self._by_first.values():
            lst.sort(key=lambda x: -len(x[0]))

    def _blocked(self, tokens: list[str]) -> set[int]:
        """Token positions covered by an exclude phrase ("ender pearl")."""
        out = set()
        for i, t in enumerate(tokens):
            for ex in self._exclude.get(t, ()):
                if tuple(tokens[i:i + len(ex)]) == ex:
                    out.update(range(i, i + len(ex)))
        return out

    def find(self, tokens: list[str], skip: str | None = None) -> list[tuple[int, str]]:
        """[(token index, hermit slug)] for every mention, ignoring the `skip` hermit (the speaker)."""
        blocked = self._blocked(tokens) if self._exclude else set()
        out = []
        i, n = 0, len(tokens)
        while i < n:
            for alias, slug in self._by_first.get(tokens[i], ()):
                k = len(alias)
                if tuple(tokens[i:i + k]) == alias and not blocked.intersection(range(i, i + k)):
                    if slug != skip:
                        out.append((i, slug))
                    i += k - 1
                    break
            i += 1
        return out

    def count(self, tokens: list[str], skip: str | None = None) -> Counter:
        return Counter(slug for _, slug in self.find(tokens, skip))
