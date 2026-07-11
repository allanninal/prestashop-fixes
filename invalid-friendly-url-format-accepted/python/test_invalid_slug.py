from fix_invalid_friendly_url_format import is_valid_slug, slugify


def test_full_url_is_invalid():
    assert is_valid_slug("abc.com") is False


def test_plain_slug_is_valid():
    assert is_valid_slug("my-product-title") is True


def test_accented_slug_valid_when_allowed():
    assert is_valid_slug("cafe-noir", allow_accented=True) is True


def test_underscore_and_hyphen_alone_still_pass_in_plain_mode():
    assert is_valid_slug("cafe_noir-2") is True


def test_space_is_invalid_even_in_accented_mode():
    assert is_valid_slug("cafe noir", allow_accented=True) is False


def test_empty_string_is_invalid():
    assert is_valid_slug("") is False


def test_slash_is_invalid():
    assert is_valid_slug("path/to/thing") is False


def test_scheme_like_value_is_invalid():
    assert is_valid_slug("https://example.com") is False


def test_dot_is_invalid():
    assert is_valid_slug("abc.com") is False


def test_colon_is_invalid():
    assert is_valid_slug("a:b") is False


def test_backslash_is_invalid():
    assert is_valid_slug("a\\b") is False


def test_slugify_strips_accents_and_punctuation():
    assert slugify("Café Noir!") == "cafe-noir"


def test_slugify_falls_back_when_empty():
    assert slugify("") == "untitled"


def test_slugify_lowercases_and_collapses_separators():
    assert slugify("  Blue   T-Shirt!! ") == "blue-t-shirt"
