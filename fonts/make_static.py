# Instance a Noto TC variable TTF to a static weight, with glyph data padded to
# 4 bytes (fontkit's subsetter writes short loca offsets, which need even lengths).
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
src, weight, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
f = TTFont(src)
inst = instancer.instantiateVariableFont(f, {"wght": weight}, updateFontNames=True, static=True)
inst["glyf"].padding = 4
inst.save(out)
g = TTFont(out); l = list(g["loca"])
print(out, g["name"].getDebugName(4), g["OS/2"].usWeightClass, "odd:", sum((l[i+1]-l[i]) % 2 for i in range(len(l)-1)))
