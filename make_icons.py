"""Generates the extension icons (rounded gradient tile with a white 'A')."""
from PIL import Image, ImageDraw, ImageFont

SIZES = [16, 32, 48, 128]
BASE = 512  # render large, downscale for crisp edges

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/SFNS.ttf",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_base():
    img = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Vertical gradient from blue to indigo inside a rounded rect mask.
    top, bottom = (37, 99, 235), (79, 70, 229)
    gradient = Image.new("RGBA", (BASE, BASE))
    gdraw = ImageDraw.Draw(gradient)
    for y in range(BASE):
        t = y / (BASE - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
        gdraw.line([(0, y), (BASE, y)], fill=color)

    mask = Image.new("L", (BASE, BASE), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.rounded_rectangle([8, 8, BASE - 8, BASE - 8], radius=110, fill=255)
    img.paste(gradient, (0, 0), mask)

    # White "A" centered.
    font = load_font(330)
    bbox = draw.textbbox((0, 0), "A", font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (BASE - w) / 2 - bbox[0]
    y = (BASE - h) / 2 - bbox[1]
    draw = ImageDraw.Draw(img)
    draw.text((x, y), "A", font=font, fill=(255, 255, 255, 255))

    return img


def main():
    import os
    os.makedirs("icons", exist_ok=True)
    base = make_base()
    for size in SIZES:
        base.resize((size, size), Image.LANCZOS).save(f"icons/icon{size}.png")
        print(f"icons/icon{size}.png")


if __name__ == "__main__":
    main()
