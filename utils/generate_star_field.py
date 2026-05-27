#!/usr/bin/env python3
"""Generate a realistic high-resolution star field image.

The generator uses Pillow only. It builds a dark noisy sky, adds faint galactic
dust, subtle nebula, distant galaxies, clusters, then renders stars with a
brightness distribution, color temperature variation, halos, and occasional
diffraction spikes.
"""

from __future__ import annotations

import argparse
import math
import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageOps


DEFAULT_WIDTH = 7680
DEFAULT_HEIGHT = 4320
DEFAULT_DENSITY = 720
DEFAULT_ARTIFACTS = "subtle"


STAR_TEMPERATURES = (
    (180, 205, 255),  # blue-white
    (215, 226, 255),
    (255, 255, 248),
    (255, 236, 210),
    (255, 206, 165),  # warm orange
)

NEBULA_PALETTES = (
    ((95, 28, 42), (170, 54, 72), (245, 112, 120)),  # hydrogen-alpha red
    ((32, 62, 92), (52, 112, 138), (142, 220, 224)),  # oxygen-teal
    ((42, 36, 82), (86, 62, 128), (196, 148, 216)),  # ionized violet
    ((84, 58, 34), (122, 84, 44), (232, 174, 104)),  # warm reflection dust
)

ARTIFACT_SETTINGS = {
    "none": {"nebulae": 0, "galaxies": 0, "clusters": 0, "opacity": 0.0},
    "subtle": {"nebulae": 2, "galaxies": 3, "clusters": 2, "opacity": 0.42},
    "medium": {"nebulae": 4, "galaxies": 6, "clusters": 3, "opacity": 0.68},
    "rich": {"nebulae": 6, "galaxies": 10, "clusters": 5, "opacity": 0.9},
}


def clamp(value: float, minimum: int = 0, maximum: int = 255) -> int:
    return max(minimum, min(maximum, int(round(value))))


def scaled_channel(color: tuple[int, int, int], intensity: float, alpha: int) -> tuple[int, int, int, int]:
    return (
        clamp(color[0] * intensity),
        clamp(color[1] * intensity),
        clamp(color[2] * intensity),
        clamp(alpha),
    )


def scale_rgb(color: tuple[int, int, int], factor: float) -> tuple[int, int, int]:
    return (clamp(color[0] * factor), clamp(color[1] * factor), clamp(color[2] * factor))


def screen_rgba(base: Image.Image, overlay: Image.Image) -> Image.Image:
    screened = ImageChops.screen(base.convert("RGB"), overlay.convert("RGB"))
    alpha = overlay.getchannel("A")
    return Image.composite(screened, base.convert("RGB"), alpha).convert("RGBA")


def paste_centered(base: Image.Image, overlay: Image.Image, x: int, y: int) -> None:
    base.alpha_composite(overlay, (int(x - overlay.width / 2), int(y - overlay.height / 2)))


def add_background_noise(image: Image.Image, rng: random.Random) -> Image.Image:
    noise = Image.effect_noise(image.size, rng.uniform(8.0, 14.0)).convert("L")
    channel = noise.point(lambda p: clamp((p - 128) * 0.20 + 3))
    blue_bias = noise.point(lambda p: clamp((p - 128) * 0.32 + 5))
    noise_rgb = Image.merge("RGB", (channel, channel, blue_bias))
    return ImageChops.add(image, noise_rgb, scale=1.0)


def add_galactic_dust(image: Image.Image, rng: random.Random) -> Image.Image:
    width, height = image.size
    scale = 5
    small_size = (max(8, width // scale), max(8, height // scale))
    dust_mask = Image.effect_noise(small_size, rng.uniform(55.0, 80.0)).convert("L")
    dust_mask = dust_mask.filter(ImageFilter.GaussianBlur(radius=max(2, min(small_size) // 90)))
    dust_mask = dust_mask.point(lambda p: clamp((p - 118) * 1.7))
    dust_mask = dust_mask.resize(image.size, Image.Resampling.BICUBIC)
    dust_mask = dust_mask.filter(ImageFilter.GaussianBlur(radius=max(4, min(width, height) // 260)))

    cool_dust = ImageOps.colorize(dust_mask, black=(0, 0, 0), white=(18, 24, 48))
    warm_mask = Image.effect_noise(small_size, rng.uniform(40.0, 65.0)).convert("L")
    warm_mask = warm_mask.filter(ImageFilter.GaussianBlur(radius=max(2, min(small_size) // 75)))
    warm_mask = warm_mask.point(lambda p: clamp((p - 132) * 1.15))
    warm_mask = warm_mask.resize(image.size, Image.Resampling.BICUBIC)
    warm_dust = ImageOps.colorize(warm_mask, black=(0, 0, 0), white=(28, 17, 13))

    return ImageChops.screen(ImageChops.screen(image, cool_dust), warm_dust)


def make_nebula_mask(size: tuple[int, int], rng: random.Random, cutoff: float) -> Image.Image:
    mask = Image.effect_noise(size, rng.uniform(85.0, 130.0)).convert("L")
    mask = mask.filter(ImageFilter.GaussianBlur(radius=max(2, min(size) // 34)))
    mask = mask.point(lambda p: clamp((p - cutoff) * 2.0))

    structure = Image.effect_noise(size, rng.uniform(22.0, 48.0)).convert("L")
    structure = structure.filter(ImageFilter.GaussianBlur(radius=max(2, min(size) // 18)))
    structure = structure.point(lambda p: clamp((p - 108) * 1.45))
    return ImageChops.multiply(mask, structure)


def radial_mask(size: tuple[int, int], power: float = 1.8) -> Image.Image:
    width, height = size
    center_x = (width - 1) / 2
    center_y = (height - 1) / 2
    max_distance = math.hypot(center_x, center_y)
    mask = Image.new("L", size)
    pixels = mask.load()
    for y in range(height):
        for x in range(width):
            distance = math.hypot(x - center_x, y - center_y) / max_distance
            pixels[x, y] = clamp((1.0 - min(1.0, distance)) ** power * 255)
    return mask


def render_nebula_patch(size: tuple[int, int], rng: random.Random, opacity: float) -> Image.Image:
    dim, mid, bright = rng.choice(NEBULA_PALETTES)
    mask = make_nebula_mask(size, rng, rng.uniform(118.0, 138.0))
    fade = radial_mask(size, power=rng.uniform(1.2, 2.1))
    alpha = ImageChops.multiply(mask, fade).point(lambda p: clamp(p * opacity * rng.uniform(0.16, 0.34)))

    color_mask = Image.effect_noise(size, rng.uniform(18.0, 38.0)).convert("L")
    color_mask = color_mask.filter(ImageFilter.GaussianBlur(radius=max(2, min(size) // 28)))
    nebula = ImageOps.colorize(color_mask, black=dim, mid=mid, white=bright).convert("RGBA")
    nebula.putalpha(alpha)

    dark_lane_mask = Image.effect_noise(size, rng.uniform(45.0, 80.0)).convert("L")
    dark_lane_mask = dark_lane_mask.filter(ImageFilter.GaussianBlur(radius=max(2, min(size) // 45)))
    dark_lane_mask = dark_lane_mask.point(lambda p: clamp((p - 146) * 3.2 * opacity))
    dark_dust = Image.new("RGBA", size, (0, 0, 0, 0))
    dark_dust.putalpha(dark_lane_mask)

    nebula = screen_rgba(Image.new("RGBA", size, (0, 0, 0, 255)), nebula)
    nebula.putalpha(alpha)
    nebula = Image.alpha_composite(nebula, dark_dust)
    return nebula.filter(ImageFilter.GaussianBlur(radius=max(1.0, min(size) / 190)))


def add_nebulae(image: Image.Image, rng: random.Random, count: int, opacity: float) -> Image.Image:
    if count <= 0:
        return image

    width, height = image.size
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    for _ in range(count):
        patch_width = rng.randrange(max(96, width // 8), max(128, width // 3))
        patch_height = rng.randrange(max(96, height // 8), max(128, height // 2))
        patch = render_nebula_patch((patch_width, patch_height), rng, opacity)
        patch = patch.rotate(rng.uniform(0, 180), resample=Image.Resampling.BICUBIC, expand=True)
        x = rng.randrange(width)
        y = rng.randrange(height)
        paste_centered(layer, patch, x, y)

    return screen_rgba(image.convert("RGBA"), layer).convert("RGB")


def add_dark_dust_lanes(image: Image.Image, rng: random.Random, opacity: float) -> Image.Image:
    width, height = image.size
    small_size = (max(64, width // 6), max(64, height // 6))
    mask = Image.effect_noise(small_size, rng.uniform(55.0, 92.0)).convert("L")
    mask = mask.filter(ImageFilter.GaussianBlur(radius=max(2, min(small_size) // 32)))
    mask = mask.point(lambda p: clamp((p - 138) * 2.3 * opacity))
    mask = mask.resize(image.size, Image.Resampling.BICUBIC)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=max(2, min(width, height) // 360)))

    dimmed = ImageEnhance.Brightness(image).enhance(0.78)
    cooled = ImageChops.multiply(dimmed, Image.new("RGB", image.size, (232, 235, 250)))
    return Image.composite(cooled, image, mask)


def render_distant_galaxy(rng: random.Random, scale: float, opacity: float) -> Image.Image:
    width = int(rng.uniform(52, 190) * scale)
    height = max(7, int(width * rng.uniform(0.16, 0.42)))
    padding = max(8, width // 3)
    size = (width + padding * 2, height + padding * 2)
    center_x = size[0] / 2
    center_y = size[1] / 2

    patch = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(patch, "RGBA")
    color = rng.choice(((210, 218, 255), (255, 235, 196), (190, 218, 255), (238, 226, 214)))

    for step in range(8, 0, -1):
        fraction = step / 8
        rx = width * 0.5 * fraction
        ry = height * 0.5 * fraction
        alpha = clamp((1 - fraction * 0.62) * 42 * opacity)
        draw.ellipse((center_x - rx, center_y - ry, center_x + rx, center_y + ry), fill=(*scale_rgb(color, 0.5 + fraction * 0.35), alpha))

    core_radius = max(1.1, height * rng.uniform(0.12, 0.24))
    draw.ellipse(
        (center_x - core_radius, center_y - core_radius, center_x + core_radius, center_y + core_radius),
        fill=(*scale_rgb(color, 1.08), clamp(150 * opacity)),
    )

    if rng.random() < 0.35:
        lane_alpha = clamp(70 * opacity)
        draw.line((center_x - width * 0.42, center_y, center_x + width * 0.42, center_y), fill=(0, 0, 0, lane_alpha), width=max(1, int(height * 0.12)))

    patch = patch.filter(ImageFilter.GaussianBlur(radius=max(0.45, height / 22)))
    return patch.rotate(rng.uniform(0, 180), resample=Image.Resampling.BICUBIC, expand=True)


def add_distant_galaxies(image: Image.Image, rng: random.Random, count: int, opacity: float) -> Image.Image:
    if count <= 0:
        return image

    width, height = image.size
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    scale = math.hypot(width, height) / math.hypot(DEFAULT_WIDTH, DEFAULT_HEIGHT)
    for _ in range(count):
        galaxy = render_distant_galaxy(rng, scale, opacity)
        paste_centered(layer, galaxy, rng.randrange(width), rng.randrange(height))

    return screen_rgba(image.convert("RGBA"), layer).convert("RGB")


def render_star_cluster(rng: random.Random, scale: float, opacity: float) -> Image.Image:
    size = int(rng.uniform(120, 340) * scale)
    size = max(48, size)
    patch = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(patch, "RGBA")
    center = size / 2
    stars = rng.randrange(80, 210)

    for _ in range(stars):
        radius_from_center = (rng.random() ** 1.9) * size * 0.48
        angle = rng.uniform(0, math.tau)
        x = center + math.cos(angle) * radius_from_center * rng.uniform(0.75, 1.15)
        y = center + math.sin(angle) * radius_from_center * rng.uniform(0.75, 1.15)
        magnitude = rng.random() ** 2.7
        star_radius = max(0.35, (0.35 + magnitude * 1.25) * scale)
        color = rng.choice(STAR_TEMPERATURES)
        alpha = clamp((42 + magnitude * 190) * opacity)
        draw.ellipse((x - star_radius, y - star_radius, x + star_radius, y + star_radius), fill=scaled_channel(color, 0.75 + magnitude, alpha))

    glow_mask = radial_mask((size, size), power=2.2).point(lambda p: clamp(p * 0.055 * opacity))
    glow = ImageOps.colorize(glow_mask, black=(0, 0, 0), white=(160, 178, 255)).convert("RGBA")
    glow.putalpha(glow_mask)
    return Image.alpha_composite(glow, patch).filter(ImageFilter.GaussianBlur(radius=0.12))


def add_star_clusters(image: Image.Image, rng: random.Random, count: int, opacity: float) -> Image.Image:
    if count <= 0:
        return image

    width, height = image.size
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    scale = math.hypot(width, height) / math.hypot(DEFAULT_WIDTH, DEFAULT_HEIGHT)
    for _ in range(count):
        cluster = render_star_cluster(rng, scale, opacity)
        paste_centered(layer, cluster, rng.randrange(width), rng.randrange(height))

    return Image.alpha_composite(image.convert("RGBA"), layer).convert("RGB")


def draw_diffraction_spike(
    draw: ImageDraw.ImageDraw,
    x: float,
    y: float,
    length: float,
    color: tuple[int, int, int],
    alpha: int,
) -> None:
    spike = (*color, clamp(alpha))
    draw.line((x - length, y, x + length, y), fill=spike, width=1)
    draw.line((x, y - length * 0.7, x, y + length * 0.7), fill=spike, width=1)


def render_star_layer(width: int, height: int, stars: int, rng: random.Random) -> Image.Image:
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer, "RGBA")
    diagonal = math.hypot(width, height)

    for _ in range(stars):
        x = rng.randrange(width)
        y = rng.randrange(height)
        temperature = rng.choice(STAR_TEMPERATURES)
        magnitude = rng.random() ** 3.35
        alpha = 18 + magnitude * 235
        radius = 0.18 + magnitude * 2.35 * (diagonal / math.hypot(DEFAULT_WIDTH, DEFAULT_HEIGHT))

        if magnitude < 0.32:
            draw.point((x, y), fill=scaled_channel(temperature, 0.65 + magnitude, alpha))
            continue

        fill = scaled_channel(temperature, 0.75 + magnitude * 0.75, alpha)
        if radius <= 0.85:
            draw.ellipse((x - 0.55, y - 0.55, x + 0.55, y + 0.55), fill=fill)
            continue

        halo_radius = radius * rng.uniform(2.2, 4.0)
        halo_alpha = clamp(alpha * rng.uniform(0.08, 0.18))
        draw.ellipse(
            (x - halo_radius, y - halo_radius, x + halo_radius, y + halo_radius),
            fill=scaled_channel(temperature, 0.45, halo_alpha),
        )
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)

        if magnitude > 0.86 and rng.random() < 0.18:
            draw_diffraction_spike(draw, x, y, radius * rng.uniform(5.0, 9.0), temperature, alpha * 0.34)

    return layer.filter(ImageFilter.GaussianBlur(radius=0.18))


def render_bright_star_layer(width: int, height: int, count: int, rng: random.Random) -> Image.Image:
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer, "RGBA")
    scale = math.hypot(width, height) / math.hypot(DEFAULT_WIDTH, DEFAULT_HEIGHT)

    for _ in range(count):
        x = rng.randrange(width)
        y = rng.randrange(height)
        color = rng.choice(STAR_TEMPERATURES)
        radius = rng.uniform(2.5, 6.5) * scale
        halo_radius = radius * rng.uniform(5.0, 9.0)
        halo_alpha = rng.randrange(18, 40)

        draw.ellipse(
            (x - halo_radius, y - halo_radius, x + halo_radius, y + halo_radius),
            fill=scaled_channel(color, 0.35, halo_alpha),
        )
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(*color, rng.randrange(210, 256)))
        draw_diffraction_spike(draw, x, y, radius * rng.uniform(8.0, 15.0), color, rng.randrange(65, 120))

    return layer.filter(ImageFilter.GaussianBlur(radius=0.12))


def generate_star_field(
    width: int,
    height: int,
    density: int,
    seed: int | None,
    include_dust: bool,
    artifacts: str,
) -> Image.Image:
    rng = random.Random(seed)
    image = Image.new("RGB", (width, height), (1, 2, 7))
    image = add_background_noise(image, rng)

    artifact_settings = ARTIFACT_SETTINGS[artifacts]

    if include_dust:
        image = add_galactic_dust(image, rng)

    if artifact_settings["opacity"]:
        opacity = float(artifact_settings["opacity"])
        image = add_nebulae(image, rng, int(artifact_settings["nebulae"]), opacity)
        image = add_dark_dust_lanes(image, rng, opacity)
        image = add_distant_galaxies(image, rng, int(artifact_settings["galaxies"]), opacity)

    megapixels = width * height / 1_000_000
    star_count = max(1, int(megapixels * density))
    bright_count = max(1, int(megapixels * density * 0.0022))

    image = Image.alpha_composite(image.convert("RGBA"), render_star_layer(width, height, star_count, rng)).convert("RGB")
    if artifact_settings["opacity"]:
        image = add_star_clusters(
            image,
            rng,
            int(artifact_settings["clusters"]),
            float(artifact_settings["opacity"]),
        )
    image = Image.alpha_composite(image.convert("RGBA"), render_bright_star_layer(width, height, bright_count, rng))
    return image.convert("RGB")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a realistic star field image with Pillow.")
    parser.add_argument("--output", "-o", default="starfield_8k.png", help="Output image path.")
    parser.add_argument("--width", type=int, default=DEFAULT_WIDTH, help="Image width in pixels.")
    parser.add_argument("--height", type=int, default=DEFAULT_HEIGHT, help="Image height in pixels.")
    parser.add_argument(
        "--density",
        type=int,
        default=DEFAULT_DENSITY,
        help="Stars per megapixel. Default produces about 24k stars at 8K.",
    )
    parser.add_argument("--seed", type=int, default=None, help="Optional deterministic random seed.")
    parser.add_argument("--no-dust", action="store_true", help="Skip subtle galactic dust texture.")
    parser.add_argument(
        "--artifacts",
        choices=tuple(ARTIFACT_SETTINGS.keys()),
        default=DEFAULT_ARTIFACTS,
        help="Amount of nebula, dark dust lanes, distant galaxies, and star clusters to add.",
    )
    parser.add_argument("--quality", type=int, default=95, help="JPEG/WebP output quality.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.width < 1 or args.height < 1:
        raise SystemExit("Width and height must be positive integers.")
    if args.density < 1:
        raise SystemExit("Density must be a positive integer.")

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image = generate_star_field(
        width=args.width,
        height=args.height,
        density=args.density,
        seed=args.seed,
        include_dust=not args.no_dust,
        artifacts=args.artifacts,
    )

    suffix = output_path.suffix.lower()
    save_kwargs: dict[str, int | bool] = {}
    if suffix in {".jpg", ".jpeg", ".webp"}:
        save_kwargs["quality"] = args.quality
    if suffix in {".jpg", ".jpeg"}:
        save_kwargs["progressive"] = True
        save_kwargs["optimize"] = True
    image.save(output_path, **save_kwargs)
    print(f"Wrote {output_path} ({args.width}x{args.height})")


if __name__ == "__main__":
    main()
