"""Build OFL-derived round one-cell numbers and two/three-cell ligatures.

Requires the already installed fontTools 4.66.1; no download or npm dependency.
The original Sarasa symbol fonts and other glyphs remain unchanged.
"""
from pathlib import Path
from math import cos, sin, pi

from fontTools import subset
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / "src/renderer/assets/fonts"
CODEPOINTS = list(range(0x2460, 0x2474)) + list(range(0x24EA, 0x2500))


def circle(pen, x, y, radius, clockwise):
    direction = -1 if clockwise else 1
    pen.moveTo((x + radius, y))
    for index in range(8):
        middle = direction * (index + 0.5) * pi / 4
        end = direction * (index + 1) * pi / 4
        control_radius = radius / cos(pi / 8)
        pen.qCurveTo((x + control_radius * cos(middle), y + control_radius * sin(middle)),
                     (x + radius * cos(end), y + radius * sin(end)))
    pen.closePath()


def number_contours(recording, original_bounds):
    left, bottom, right, top = original_bounds
    digits = DecomposingRecordingPen(None)
    contour = []
    for command, arguments in recording.value:
        contour.append((command, arguments))
        if command != "closePath":
            continue
        bounds = BoundsPen(None)
        for operation, values in contour:
            getattr(bounds, operation)(*values)
        x0, y0, x1, y1 = bounds.bounds
        if not (x1 - x0 >= (right - left) * 0.65 and y1 - y0 >= (top - bottom) * 0.65):
            digits.value.extend(contour)
        contour = []
    return digits


def blank_sequences(required, prefix=(), cells=0):
    """Consume complete real blanks, stopping as soon as the run fits."""
    if cells >= required:
        yield prefix, cells - required
        return
    for name, width in (("space", 1), ("fullspace", 2)):
        yield from blank_sequences(required, prefix + (name,), cells + width)

for style in ("Regular", "Bold"):
    font = TTFont(DIRECTORY / f"SarasaTermJ-Symbols-{style}.ttf", recalcTimestamp=False)
    options = subset.Options()
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=CODEPOINTS)
    subsetter.subset(font)
    # The terminal shapes horizontal text; new ligatures have no vertical metrics.
    for tag in ("vhea", "vmtx"):
        if tag in font:
            del font[tag]
    glyph_set = font.getGlyphSet()
    originals = {}
    for codepoint in CODEPOINTS:
        name = font.getBestCmap()[codepoint]
        recording = DecomposingRecordingPen(glyph_set)
        glyph_set[name].draw(recording)
        bounds = BoundsPen(glyph_set)
        glyph_set[name].draw(bounds)
        originals[name] = (recording, bounds.bounds)

    order = list(font.getGlyphOrder())
    for name, advance in (("space", 500), ("fullspace", 1000), ("cockpit.empty", 0)):
        font["glyf"][name] = TTGlyphPen(None).glyph()
        font["hmtx"][name] = (advance, 0)
        order.append(name)
    for table in font["cmap"].tables:
        if table.isUnicode():
            table.cmap[0x20] = "space"
            table.cmap[0x3000] = "fullspace"

    features = []
    reverse_cmap = {name: codepoint for codepoint, name in font.getBestCmap().items()}
    for name, (recording, bounds) in originals.items():
        left, bottom, right, top = bounds
        center_y = (bottom + top) / 2
        digits = number_contours(recording, bounds)
        digit_bounds = BoundsPen(None)
        digits.replay(digit_bounds)
        digit_left, digit_bottom, digit_right, digit_top = digit_bounds.bounds
        codepoint = reverse_cmap[name]
        filled = 0x24EB <= codepoint <= 0x24F4 or codepoint == 0x24FF
        doubled = 0x24F5 <= codepoint <= 0x24FE
        for suffix, diameter, advance in (("", 500, 500), (".wide", 860, 1000), (".full", 860, 1500)):
            output_name = name + suffix
            ink_advance = min(advance, 1000)
            pen = TTGlyphPen(None)
            circle(pen, ink_advance / 2, center_y, diameter / 2, True)
            if not filled:
                circle(pen, ink_advance / 2, center_y, diameter * (0.39 if style == "Bold" else 0.43), False)
            if doubled:
                circle(pen, ink_advance / 2, center_y, diameter * 0.35, True)
                circle(pen, ink_advance / 2, center_y, diameter * 0.29, False)
            restored_x = (top - bottom) / (right - left)
            limit = diameter * (0.45 if doubled else 0.70 if not suffix else 0.64)
            scale = min(limit / ((digit_right - digit_left) * restored_x), limit / (digit_top - digit_bottom))
            x_scale, y_scale = restored_x * scale, scale
            digits.replay(TransformPen(pen, (x_scale, 0, 0, y_scale,
                ink_advance / 2 - (digit_left + digit_right) / 2 * x_scale,
                center_y - (digit_top + digit_bottom) / 2 * y_scale)))
            font["glyf"][output_name] = pen.glyph()
            font["hmtx"][output_name] = (advance, round((ink_advance - diameter) / 2))
            if suffix:
                order.append(output_name)
        features.extend((f"sub {name} space by {name}.wide;", f"sub {name} fullspace by {name}.full;"))
    font.setGlyphOrder(order)
    if "GSUB" in font:
        del font["GSUB"]
    # A joined run such as ①② + a fullwidth blank already occupies four
    # cells. Widen both numbers and consume that blank; never add columns.
    definitions = [
        "@Circled = [" + " ".join(originals) + "];",
        "@WideCircled = [" + " ".join(name + ".wide" for name in originals) + "];",
        "lookup Widen { sub @Circled by @WideCircled; } Widen;",
        "lookup Blank0 { sub space by cockpit.empty; sub fullspace by cockpit.empty; } Blank0;",
        "lookup Blank1 { sub fullspace by space; } Blank1;",
    ]
    run_lookups = []
    for count in range(8, 1, -1):
        name = f"ReadableRun{count}"
        rules = []
        for blanks, remainder in blank_sequences(count):
            marked = ["@Circled'"] * count + [blank + "'" for blank in blanks]
            # Never enlarge just the suffix of a longer unsupported run.
            rules.append("ignore sub @Circled " + " ".join(marked) + ";")
            substitutions = ["@Circled' lookup Widen"] * count
            substitutions += [blank + "' lookup " + ("Blank1" if remainder and index == len(blanks) - 1 else "Blank0")
                              for index, blank in enumerate(blanks)]
            rules.append("sub " + " ".join(substitutions) + ";")
        definitions.append(f"lookup {name} {{\n" + "\n".join(rules) + f"\n}} {name};")
        run_lookups.append(f"lookup {name};")
    addOpenTypeFeaturesFromString(font, "\n".join(definitions) + "\nfeature liga {\n" +
                                 "\n".join(run_lookups + features) + "\n} liga;")
    # Canvas text shaping splits ASCII spaces into a separate run. An explicit
    # variation selects the same wide outline without relying on that ligature.
    variation = CmapSubtable.newSubtable(14)
    variation.platformID = 0
    variation.platEncID = 5
    variation.language = 0
    variation.cmap = {}
    variation.uvsDict = {0xFE00: [(codepoint, font.getBestCmap()[codepoint] + ".wide") for codepoint in CODEPOINTS]}
    font["cmap"].tables.append(variation)
    for record in font["name"].names:
        if record.nameID in (1, 2, 3, 4, 6, 16, 17):
            text = {
                1: "Cockpit Circled Numbers", 2: style,
                3: f"CockpitCircledNumbers-{style}-20261027-readable-runs",
                4: f"Cockpit Circled Numbers {style}",
                6: f"CockpitCircledNumbers-{style}",
                16: "Cockpit Circled Numbers", 17: style,
            }[record.nameID]
            record.string = text.encode(record.getEncoding())
    font.save(DIRECTORY / f"CockpitCircledNumbers-{style}.ttf")
    print(f"{style}: {len(originals)} circled numbers, compact + wide/fullspace ligatures")
