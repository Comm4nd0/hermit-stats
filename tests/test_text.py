from hermitstats import build, text
from hermitstats.config import Collection, Hermit
from hermitstats.mentions import MentionFinder
import re

HERMITS = [
    Hermit("PearlescentMoon", "@PearlescentMoon", ["pearl", "pearlescent moon"], ["ender pearl", "ender pearls"]),
    Hermit("Mumbo Jumbo", "@ThatMumboJumbo", ["mumbo", "mumbo jumbo"]),
    Hermit("Grian", "@Grian", ["grian"]),
]


def find(s, skip=None):
    return MentionFinder(HERMITS).count(text.tokenize(s), skip=skip)


def test_longest_alias_counts_once():
    assert find("Mumbo Jumbo built a thing, then mumbo left") == {"mumbo-jumbo": 2}


def test_exclude_phrases_block_alias():
    assert find("throw an ender pearl to Pearl") == {"pearlescentmoon": 1}
    assert find("two ender pearls") == {}


def test_speaker_is_not_counted():
    assert find("I'm Grian and this is Mumbo", skip="grian") == {"mumbo-jumbo": 1}


def test_word_boundaries():
    assert find("pearly whites and grianite") == {}


def test_caption_heat_artifact_becomes_music():
    t = text.clean("Heat. Heat. hello everyone, the heat is on")
    assert "[Music]" in t and "the heat is on" in t
    assert text.music_cues(t) == 1


def test_phrase_counting_and_ngrams():
    toks = text.tokenize("Oh no. Oh no, oh NO!")
    assert text.count_phrase(toks, ("oh", "no")) == 3
    assert text.ngram_index(toks)[("oh", "no")] == 3


def test_mattr_is_length_fair():
    rich = [f"w{i}" for i in range(600)]
    assert text.mattr(rich) == 1.0
    assert text.mattr(["a", "b"] * 300) < 0.01


def test_episode_number():
    assert build.episode_number("Hermitcraft 11: Episode 12 - Fresh Start") == 12
    assert build.episode_number("THE CONCRETE KING! - HermitCraft S11 Ep28") == 28
    assert build.episode_number("Sponge Strike Squad! #DO3Podcast - Hermitcraft 11: #3") == 3
    assert build.episode_number("Base tour") is None


def test_collection_filters():
    c = Collection("Season 11", re.compile(r"x"), None, re.compile(r"stream", re.I), "20251101")
    assert c.wants("Hermitcraft 11 Ep 3", "20251201")
    assert not c.wants("Hermitcraft 11 Streams")
    assert not c.wants("Hermitcraft #11", "20150226")


def test_guests_only_join_collections_that_name_them():
    martyn = Hermit("InTheLittleWood", "@martyn", ["martyn"], guest=True)
    season = Collection("Season 11", re.compile(r"x"), None)
    life = Collection("Nice Life", re.compile(r"x"), None, members=["grian", "inthelittlewood"])
    assert season.includes(HERMITS[2]) and not season.includes(martyn)
    assert life.includes(martyn) and life.includes(HERMITS[2]) and not life.includes(HERMITS[1])
