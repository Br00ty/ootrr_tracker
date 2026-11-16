"""Builds index.html: src/ui.html with the scripts and data/data.json inlined, one file that runs offline."""
import os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
r = lambda p: open(p, encoding="utf-8").read()
page = r("src/ui.html")
for mark, path in (("/*ENGINE*/", "src/engine.js"), ("/*AUTO*/", "src/autotrack.js"), ("/*SEED*/", "src/seed.js")):
    page = page.replace(mark, r(path))
page = page.replace("/*DATA*/", r("data/data.json").replace("</", "<\\/"))
open("index.html", "w", encoding="utf-8").write(page)
print("index.html written,", len(page), "bytes")
