"""Generate src-tauri/icons/tray-icon-template.png.

This is a macOS menu-bar template image of the OrbiterX satellite logo.
Re-run after editing:

    python3 src-tauri/icons/tray-icon-template.gen.py

Requires Pillow (pip install Pillow).
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageChops

W_LOGICAL, H_LOGICAL = 22, 22
SCALE = 4
W, H = W_LOGICAL * SCALE, H_LOGICAL * SCALE

def main():
    # Base transparent image
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Scale coordinates
    # Satellite logo matches:
    # Outer bounds: x=[5, 17], y=[4, 18]
    # Inner cutout: x=[8, 14], y=[7, 15]
    # Center core: x=[8, 14], y=[10, 15]
    
    # Draw outer boundary box (white mask, fully opaque in alpha)
    draw.rectangle([5 * SCALE, 4 * SCALE, 17 * SCALE - 1, 18 * SCALE - 1], fill=(255, 255, 255, 255))
    
    # Punch out inner cutout (transparent)
    draw.rectangle([8 * SCALE, 7 * SCALE, 14 * SCALE - 1, 15 * SCALE - 1], fill=(0, 0, 0, 0))
    
    # Draw center core (white)
    draw.rectangle([8 * SCALE, 10 * SCALE, 14 * SCALE - 1, 15 * SCALE - 1], fill=(255, 255, 255, 255))

    # Resize with Lanczos downsampling for smooth anti-aliased rendering
    out_img = img.resize((W_LOGICAL, H_LOGICAL), Image.Resampling.LANCZOS)
    
    out = Path(__file__).parent / "tray-icon-template.png"
    out_img.save(out)
    print(f"wrote {out} {out_img.size}")

if __name__ == "__main__":
    main()
