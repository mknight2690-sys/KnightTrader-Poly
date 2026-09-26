from PIL import Image, ImageDraw, ImageFont
import struct

size = 256
img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Yellow background circle
margin = 4
draw.ellipse([margin, margin, size - margin, size - margin], fill=(245, 197, 66, 255))

# Large bold black B
font_size = 180
try:
    font = ImageFont.truetype("arialbd.ttf", font_size)
except Exception:
    font = ImageFont.load_default()

text = "B"
bbox = draw.textbbox((0, 0), text, font=font)
text_width = bbox[2] - bbox[0]
text_height = bbox[3] - bbox[1]
x = (size - text_width) // 2
y = (size - text_height) // 2 - 8

draw.text((x, y), text, fill=(0, 0, 0, 255), font=font)

# Save source PNG
png_path = 'C:/Users/mknig/Desktop/KnightTrader-Blofin/assets/icon-source.png'
img.save(png_path, 'PNG')

# Save multi-size ICO
ico_path = 'C:/Users/mknig/Desktop/KnightTrader-Blofin/assets/icon.ico'
img.save(ico_path, format='ICO', sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])

print('Saved large bold B icon')
