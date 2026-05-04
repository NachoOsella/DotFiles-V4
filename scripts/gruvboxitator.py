#!/usr/bin/env python3
from __future__ import annotations

import argparse
import colorsys
import math
import random
import sys
import warnings
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

from PIL import Image, ImageEnhance, ImageFilter, ImageOps

warnings.filterwarnings("ignore", category=DeprecationWarning)

RGB = Tuple[int, int, int]
FloatRGB = Tuple[float, float, float]

PALETTE = {
    "bg0": "#1d2021",
    "bg1": "#282828",
    "bg2": "#32302f",
    "bg3": "#3c3836",
    "bg4": "#45403d",
    "bg5": "#504945",
    "fg0": "#d4be98",
    "fg1": "#ddc7a1",
    "fg2": "#c7b188",
    "red": "#ea6962",
    "orange": "#e78a4e",
    "yellow": "#d8a657",
    "green": "#a9b665",
    "aqua": "#89b482",
    "blue": "#7daea3",
    "purple": "#d3869b",
}

# Rampa tonal cuidadosamente sesgada hacia el fondo Dark Hard. Mantiene negros
# profundos y highlights cálidos, que es donde Gruvbox Material se siente mejor.
TONAL_RAMP: Sequence[Tuple[float, str]] = (
    (0.00, "bg0"),
    (0.13, "bg1"),
    (0.28, "bg2"),
    (0.45, "bg3"),
    (0.62, "bg4"),
    (0.78, "fg2"),
    (0.92, "fg0"),
    (1.00, "fg1"),
)

ACCENTS: Sequence[Tuple[str, str]] = (
    ("red", PALETTE["red"]),
    ("orange", PALETTE["orange"]),
    ("yellow", PALETTE["yellow"]),
    ("green", PALETTE["green"]),
    ("aqua", PALETTE["aqua"]),
    ("blue", PALETTE["blue"]),
    ("purple", PALETTE["purple"]),
)


def hex_to_rgb(value: str) -> RGB:
    value = value.strip().lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def clamp255(x: float) -> int:
    return 0 if x < 0 else 255 if x > 255 else int(round(x))


def mix(a: RGB | FloatRGB, b: RGB | FloatRGB, t: float) -> FloatRGB:
    t = clamp01(t)
    return (
        float(a[0]) + (float(b[0]) - float(a[0])) * t,
        float(a[1]) + (float(b[1]) - float(a[1])) * t,
        float(a[2]) + (float(b[2]) - float(a[2])) * t,
    )


def luminance(c: RGB | FloatRGB) -> float:
    return (0.2126 * float(c[0]) + 0.7152 * float(c[1]) + 0.0722 * float(c[2])) / 255.0


def soft_light(a: float, b: float) -> float:
    # a: base, b: blend, ambos 0..1
    if b < 0.5:
        return 2 * a * b + a * a * (1 - 2 * b)
    return 2 * a * (1 - b) + math.sqrt(max(a, 0.0)) * (2 * b - 1)


def tonal_color(t: float) -> FloatRGB:
    t = clamp01(t)
    ramp = [(pos, hex_to_rgb(PALETTE[name])) for pos, name in TONAL_RAMP]
    for (p0, c0), (p1, c1) in zip(ramp, ramp[1:]):
        if t <= p1:
            local = 0.0 if p1 == p0 else (t - p0) / (p1 - p0)
            # Smoothstep para evitar bandas duras.
            local = local * local * (3.0 - 2.0 * local)
            return mix(c0, c1, local)
    return tuple(float(x) for x in ramp[-1][1])  # type: ignore[return-value]


def nearest_accent_by_hue(r: int, g: int, b: int) -> RGB:
    h, _l, _s = colorsys.rgb_to_hls(r / 255.0, g / 255.0, b / 255.0)
    best: Tuple[float, RGB] | None = None
    for _name, hx in ACCENTS:
        cr, cg, cb = hex_to_rgb(hx)
        ch, _cl, _cs = colorsys.rgb_to_hls(cr / 255.0, cg / 255.0, cb / 255.0)
        d = abs(h - ch)
        d = min(d, 1.0 - d)
        if best is None or d < best[0]:
            best = (d, (cr, cg, cb))
    assert best is not None
    return best[1]


def retone_to_luma(
    color: FloatRGB, target_luma: float, amount: float = 0.78
) -> FloatRGB:
    """Ajusta suavemente la luminosidad sin destruir el matiz Gruvbox."""
    current = max(luminance(color), 1e-5)
    scale = (target_luma / current) ** 0.72
    scaled = tuple(clamp255(ch * scale) for ch in color)
    return mix(color, scaled, amount)


def percentile_bounds(gray: Image.Image, low: float, high: float) -> Tuple[int, int]:
    hist = gray.histogram()
    total = sum(hist)
    if total <= 0:
        return 0, 255
    lo_target = total * low
    hi_target = total * high
    acc = 0
    lo = 0
    for i, n in enumerate(hist):
        acc += n
        if acc >= lo_target:
            lo = i
            break
    acc = 0
    hi = 255
    for i, n in enumerate(hist):
        acc += n
        if acc >= hi_target:
            hi = i
            break
    if hi <= lo:
        return 0, 255
    return lo, hi


def normalize_luma(y: float, lo: int, hi: int, gamma: float) -> float:
    t = ((y * 255.0) - lo) / max(1.0, hi - lo)
    t = clamp01(t)
    return t**gamma


def enforce_bg0_black_floor(image: Image.Image) -> Image.Image:
    """Reemplaza negro real por bg0 (#1d2021), el negro de Dark Hard."""
    bg0 = hex_to_rgb(PALETTE["bg0"])
    bg0_luma = luminance(bg0)
    pixels = []
    for px in image.convert("RGB").getdata():
        if luminance(px) < bg0_luma:
            pixels.append(bg0)
        else:
            pixels.append(px)
    out = Image.new("RGB", image.size)
    out.putdata(pixels)
    return out


def gruvboxitate(
    image: Image.Image,
    strength: float = 0.94,
    contrast: float = 1.10,
    color_strength: float = 0.64,
    warmth: float = 0.02,
    grain: float = 0.010,
    vignette: float = 0.20,
    sharpen: float = 0.70,
) -> Image.Image:
    src = ImageOps.exif_transpose(image).convert("RGB")

    # Contraste local antes de re-mapear: conserva bordes en superficies grandes
    # como naves, planetas y cielo espacial.
    work = ImageEnhance.Contrast(src).enhance(contrast)
    if sharpen > 0:
        work = work.filter(
            ImageFilter.UnsharpMask(radius=1.35, percent=int(90 * sharpen), threshold=3)
        )

    gray = ImageOps.grayscale(work)
    lo, hi = percentile_bounds(gray, 0.006, 0.994)
    w, h = work.size
    cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
    max_dist = math.sqrt(cx * cx + cy * cy) or 1.0

    rng = random.Random(0x67727576)  # gruv, determinístico
    out_pixels: List[RGB] = []
    src_pixels = list(work.getdata())

    for idx, (r, g, b) in enumerate(src_pixels):
        y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
        # Dark Hard necesita una curva profunda: sombras ricas, medios leíbles.
        # Mezclamos luminancia absoluta con una normalización suave. Así una foto
        # nocturna/espacial no se lava al estirar demasiado el histograma.
        normalized = normalize_luma(y, lo, hi, gamma=0.92)
        t = 0.72 * clamp01(y) + 0.28 * normalized
        t = soft_light(t, 0.53)

        # Vignette cinematográfico: empuja bordes hacia bg0/bg1 sin aplastar centro.
        if vignette > 0:
            x = idx % w
            yy = idx // w
            d = math.sqrt((x - cx) ** 2 + (yy - cy) ** 2) / max_dist
            t *= 1.0 - vignette * (d**1.65)

        neutral = tonal_color(t)
        hls = colorsys.rgb_to_hls(r / 255.0, g / 255.0, b / 255.0)
        sat = hls[2]
        accent = nearest_accent_by_hue(r, g, b)

        # La saturación original decide cuánto color de acento entra. Incluso en
        # imágenes casi grises se permite un tinte mínimo para que no quede sepia plano.
        accent_mix = clamp01((sat - 0.05) / 0.55) * color_strength
        if y > 0.62:
            accent_mix *= 0.72  # highlights más crema que neón
        if y < 0.20:
            accent_mix *= 0.55  # sombras más Material Dark

        colored = mix(neutral, accent, accent_mix)

        # Tinte cálido global Gruvbox, solo en medios/luces. Las sombras quedan
        # gris carbón Dark Hard, nunca marrones ni negro puro.
        warm_target = hex_to_rgb(PALETTE["yellow"])
        warm_amount = warmth * (t**1.8)
        colored = mix(colored, warm_target, warm_amount)

        # Reencaja luminosidad para preservar geometría de la imagen original.
        # Dark Hard funciona mejor con negros cerca de bg0 y medios contenidos.
        colored = retone_to_luma(colored, target_luma=0.035 + 0.70 * t, amount=0.74)

        # Las zonas oscuras se anclan explícitamente en bg0 (#1d2021): ese es el
        # "negro" de Gruvbox Material Dark Hard.
        bg0 = hex_to_rgb(PALETTE["bg0"])
        bg1 = hex_to_rgb(PALETTE["bg1"])
        if t < 0.40:
            shadow_anchor = mix(bg0, bg1, clamp01(t / 0.40))
            colored = mix(colored, shadow_anchor, (1.0 - t / 0.40) ** 0.55)

        # Aplicación final: deja respirar parte del valor original si strength < 1.
        final = mix((r, g, b), colored, strength)

        # Piso absoluto: si algo quedó por debajo del gris más oscuro de la
        # paleta, se reemplaza/levanta a bg0 en vez de caer a negro real.
        if luminance(final) < luminance(bg0):
            final = bg0

        if grain > 0:
            # Grano fino oscuro/cálido; evita superficies digitales demasiado lisas.
            n = (rng.random() - 0.5) * 255.0 * grain
            final = (final[0] + n, final[1] + n * 0.94, final[2] + n * 0.82)

        out_pixels.append((clamp255(final[0]), clamp255(final[1]), clamp255(final[2])))

    out = Image.new("RGB", work.size)
    out.putdata(out_pixels)

    # Ligero acabado de contraste y nitidez después del color grade.
    out = ImageEnhance.Contrast(out).enhance(1.035)
    out = out.filter(ImageFilter.UnsharpMask(radius=0.65, percent=38, threshold=2))
    out = enforce_bg0_black_floor(out)
    return out


def save_palette_swatch(path: Path) -> None:
    cell_w, cell_h = 180, 84
    names = [
        "bg0",
        "bg1",
        "bg2",
        "bg3",
        "bg4",
        "fg0",
        "red",
        "orange",
        "yellow",
        "green",
        "aqua",
        "blue",
        "purple",
    ]
    img = Image.new(
        "RGB",
        (cell_w * 4, cell_h * math.ceil(len(names) / 4)),
        hex_to_rgb(PALETTE["bg0"]),
    )
    from PIL import ImageDraw, ImageFont

    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 16)
    except Exception:
        font = ImageFont.load_default()
    for i, name in enumerate(names):
        x = (i % 4) * cell_w
        y = (i // 4) * cell_h
        color = hex_to_rgb(PALETTE[name])
        draw.rectangle([x, y, x + cell_w, y + cell_h], fill=color)
        text_color = (
            hex_to_rgb(PALETTE["bg0"])
            if luminance(color) > 0.45
            else hex_to_rgb(PALETTE["fg0"])
        )
        draw.text((x + 10, y + 16), name, fill=text_color, font=font)
        draw.text((x + 10, y + 42), PALETTE[name], fill=text_color, font=font)
    img.save(path)


PRESETS: Dict[str, Dict[str, float | str]] = {
    "1": {
        "name": "dark-hard",
        "label": "Dark Hard balanceado: gris oscuro #1d2021, contraste fino",
        "strength": 1.0,
        "contrast": 1.18,
        "color_strength": 0.62,
        "warmth": 0.01,
        "grain": 0.004,
        "vignette": 0.32,
        "sharpen": 0.70,
    },
    "2": {
        "name": "dark-hard-gray",
        "label": "Mas gris y sobrio: menos color, fondo bien carbon",
        "strength": 1.0,
        "contrast": 1.12,
        "color_strength": 0.34,
        "warmth": 0.0,
        "grain": 0.003,
        "vignette": 0.30,
        "sharpen": 0.62,
    },
    "3": {
        "name": "dark-hard-cinematic",
        "label": "Cinematico: mas contraste, luces crema y viñeta",
        "strength": 1.0,
        "contrast": 1.24,
        "color_strength": 0.76,
        "warmth": 0.018,
        "grain": 0.006,
        "vignette": 0.36,
        "sharpen": 0.82,
    },
    "4": {
        "name": "dark-hard-soft",
        "label": "Suave: conserva mas de la foto original",
        "strength": 0.88,
        "contrast": 1.06,
        "color_strength": 0.46,
        "warmth": 0.008,
        "grain": 0.002,
        "vignette": 0.22,
        "sharpen": 0.45,
    },
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Gruvboxitator: convierte una imagen a Gruvbox Material Dark Hard."
    )
    p.add_argument("input", type=Path, help="Path de la imagen de entrada")
    p.add_argument(
        "-p",
        "--preset",
        choices=sorted(PRESETS),
        help="Preset sin menu: 1 balanceado, 2 gris, 3 cinematico, 4 suave",
    )
    p.add_argument("-o", "--output", type=Path, help="Path de salida opcional")
    p.add_argument(
        "--swatch",
        action="store_true",
        help="Tambien guarda una muestra de la paleta al lado de la imagen",
    )
    return p.parse_args()


def ask_choice() -> str:
    print("\nGruvboxitator")
    print("Paleta: Gruvbox Material Dark Hard. Negro reemplazado por bg0 #1d2021.\n")
    print("Elegi un estilo:")
    for key in sorted(PRESETS):
        print(f"  {key}) {PRESETS[key]['label']}")
    print()

    while True:
        choice = input("Opcion [1]: ").strip() or "1"
        if choice in PRESETS:
            return choice
        print("Opcion invalida. Usa 1, 2, 3 o 4.")


def ask_yes_no(question: str, default: bool = False) -> bool:
    suffix = "[S/n]" if default else "[s/N]"
    answer = input(f"{question} {suffix}: ").strip().lower()
    if not answer:
        return default
    return answer in {"s", "si", "sí", "y", "yes"}


def output_path_for(input_path: Path, preset: Dict[str, float | str]) -> Path:
    return input_path.with_name(f"{input_path.stem}-{preset['name']}.png")


def main() -> None:
    args = parse_args()
    if not args.input.exists():
        raise SystemExit(f"No existe la imagen: {args.input}")

    interactive = sys.stdin.isatty() and args.preset is None
    preset_key = ask_choice() if interactive else (args.preset or "1")
    preset = PRESETS[preset_key]
    output = args.output or output_path_for(args.input, preset)
    save_swatch = args.swatch or (interactive and ask_yes_no("Guardar swatch de paleta?", False))

    print(f"\nProcesando: {args.input}")
    print(f"Estilo: {preset['label']}")
    print(f"Salida: {output}")

    img = Image.open(args.input)
    result = gruvboxitate(
        img,
        strength=float(preset["strength"]),
        contrast=float(preset["contrast"]),
        color_strength=float(preset["color_strength"]),
        warmth=float(preset["warmth"]),
        grain=float(preset["grain"]),
        vignette=float(preset["vignette"]),
        sharpen=float(preset["sharpen"]),
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    result.save(output)

    if save_swatch:
        swatch = output.with_name(output.stem + "-palette.png")
        save_palette_swatch(swatch)
        print(f"Swatch: {swatch}")

    print(f"Listo: {output}")


if __name__ == "__main__":
    main()
