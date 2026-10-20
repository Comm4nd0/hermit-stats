"""Tokenising, phrase counting, and the word lists the stats are built from."""

import re
from collections import Counter

# Common English function words, plus conversational glue. Kept inline so there's no NLTK download step.
STOPWORDS = frozenset("""
a about above after again against all also am an and any are aren't as at be because been before being
below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down
during each few for from further get got gonna had hadn't has hasn't have haven't having he he'd he'll
he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it
it's its itself just let's me more most mustn't my myself no nor not now of off on once only or other
ought our ours ourselves out over own really same shan't she she'd she'll she's should shouldn't so some
such than that that's the their theirs them themselves then there there's these they they'd they'll
they're they've this those through to too under until up us very was wasn't we we'd we'll we're we've
were weren't what what's when when's where where's which while who who's whom why why's will with won't
would wouldn't you you'd you'll you're you've your yours yourself yourselves yeah oh okay ok uh um
one two going go know like right well thing things want wanna way see something lot kind
put make need think look actually bit gotta little come back bunch maybe much stuff even
""".split())

FILLERS = ("um", "uh", "like", "you know", "i mean", "basically", "literally", "actually",
           "kind of", "sort of", "so yeah", "honestly", "i guess")

# Themed vocabularies, counted per video so any selection can be summed in the browser.
LEXICON = {
    "Mobs": ["creeper", "creepers", "zombie", "zombies", "skeleton", "skeletons", "enderman", "endermen",
             "villager", "villagers", "piglin", "piglins", "wither", "warden", "phantom", "phantoms", "slime",
             "ghast", "blaze", "blazes", "guardian", "guardians", "shulker", "shulkers", "axolotl", "axolotls",
             "allay", "sniffer", "breeze", "armadillo", "bee", "bees", "cat", "cats", "wolf", "dog", "parrot",
             "horse", "witch", "pillager", "pillagers", "evoker", "ravager", "iron golem", "chicken", "cow",
             "sheep", "pig", "frog", "frogs", "turtle", "squid", "dolphin", "camel"],
    "Materials": ["diamond", "diamonds", "netherite", "iron", "gold", "emerald", "emeralds", "copper",
                  "obsidian", "concrete", "terracotta", "deepslate", "amethyst", "quartz", "glass", "wool",
                  "stone", "cobblestone", "cobble", "sandstone", "prismarine", "blackstone", "basalt",
                  "mud", "bamboo", "oak", "spruce", "birch", "cherry", "mangrove", "tuff", "calcite"],
    "Redstone & tech": ["redstone", "piston", "pistons", "observer", "observers", "hopper", "hoppers",
                        "repeater", "repeaters", "comparator", "comparators", "dropper", "dispenser",
                        "flying machine", "slime block", "contraption", "sorter", "sorting system",
                        "farm", "farms", "tnt", "minecart", "minecarts", "rails", "crafter", "machine"],
    "Hermitcraft life": ["shopping district", "shop", "shops", "prank", "pranks", "base", "mega base",
                         "megabase", "build", "building", "game", "games", "war", "election", "mayor",
                         "event", "podcast", "sidequest", "team", "deal", "trade", "customers", "business",
                         "meeting", "hermits", "server"],
    "Exclamations": ["oh my gosh", "oh no", "wow", "whoa", "let's go", "yes", "nice", "dude", "amazing",
                     "awesome", "beautiful", "perfect", "excellent", "brilliant", "incredible", "ooh",
                     "hooray", "what the", "oh dear", "oh boy"],
    "Fillers": list(FILLERS),
}

_BRACKETED = re.compile(r"\[[^\]]*\]|\([^)]*\)")     # [Music], [Applause], (laughs)
_WORD = re.compile(r"[a-z0-9]+(?:'[a-z]+)?")
_LAUGH = re.compile(r"[\[(]\s*(laughter|laughs|laughing|chuckles)\s*[\])]", re.I)
_MUSIC = re.compile(r"[\[(]\s*music\s*[\])]", re.I)
# YouTube's speech recogniser hears intro music as "heat heat heat"; treat a run of them as a music cue.
_HEAT = re.compile(r"\bheat\b(?:\W+heat\b)+\W*", re.I)


def clean(text: str) -> str:
    return _HEAT.sub(" [Music] ", text)


def tokenize(text: str) -> list[str]:
    text = _BRACKETED.sub(" ", text.lower()).replace("’", "'")
    return _WORD.findall(text)


def laughs(text: str) -> int:
    return len(_LAUGH.findall(text))


def music_cues(text: str) -> int:
    return len(_MUSIC.findall(text))


def phrase_tokens(phrase: str) -> tuple[str, ...]:
    return tuple(tokenize(phrase))


def count_phrase(tokens: list[str], phrase: tuple[str, ...]) -> int:
    n = len(phrase)
    if not n:
        return 0
    first = phrase[0]
    return sum(1 for i in range(len(tokens) - n + 1) if tokens[i] == first and tuple(tokens[i:i + n]) == phrase)


def ngram_index(tokens: list[str], max_n: int = 3) -> Counter:
    """Counts of every 1..max_n-gram, keyed by tuple. One pass makes all phrase lookups O(1)."""
    c = Counter()
    for n in range(1, max_n + 1):
        c.update(zip(*(tokens[i:] for i in range(n))))
    return c


def mattr(tokens: list[str], window: int = 500) -> float | None:
    """Moving-average type/token ratio: vocabulary richness that doesn't fall with video length."""
    if len(tokens) < window:
        return round(len(set(tokens)) / len(tokens), 4) if tokens else None
    counts = Counter(tokens[:window])
    total = len(counts)
    for i in range(window, len(tokens)):
        old, new = tokens[i - window], tokens[i]
        counts[old] -= 1
        if counts[old] == 0:
            del counts[old]
        counts[new] += 1
        total += len(counts)
    return round(total / (len(tokens) - window + 1) / window, 4)


def interesting(w: str) -> bool:
    return len(w) >= 2 and w not in STOPWORDS and not w.isdigit()
