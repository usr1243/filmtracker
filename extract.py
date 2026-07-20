#!/usr/bin/env python3
"""Wandelt Filmliste_gefiltert.xlsx in movies-seed.json um (Startimport für den Filmtracker)."""
import zipfile, re, json, html, sys

SRC = "/Users/Lorenz/Downloads/Movies/Filmliste_gefiltert.xlsx"
OUT = "/Users/Lorenz/Downloads/code/Claude-Brain/projects/filmtracker/movies-seed.json"

data = zipfile.ZipFile(SRC).read("xl/worksheets/sheet1.xml").decode("utf-8")
row_blocks = re.findall(r'<row r="(\d+)"[^>]*>(.*?)</row>', data, re.S)

movies = []
for rnum, rb in row_blocks:
    if rnum == "1":
        continue  # Kopfzeile
    cells = {}
    for m in re.finditer(r'<c r="([A-E])\d+"[^>]*>(?:<is><t(?:[^>]*)>(.*?)</t></is>)?</c>', rb, re.S):
        cells[m.group(1)] = html.unescape(m.group(2)) if m.group(2) else ""
    title = cells.get("C", "").strip()
    if not title:
        continue
    movies.append({
        "id": len(movies) + 1,
        "title": title,
        "rating": cells.get("A", "").strip(),        # LOVE/LIKE/MEH/DISLIKE/QUEUE
        "status": cells.get("B", "").strip(),        # Nachgeschaut / Noch nicht geschaut
        "updated": cells.get("D", "").strip(),
        "comment": cells.get("E", "").strip(),
        "genre": "", "overview": "", "poster": ""    # wird später via TMDb gefüllt
    })

with open(OUT, "w", encoding="utf-8") as f:
    json.dump({"movies": movies, "nextId": len(movies) + 1, "tmdbKey": ""}, f, ensure_ascii=False, indent=1)

ratings, statuses = {}, {}
for m in movies:
    ratings[m["rating"]] = ratings.get(m["rating"], 0) + 1
    statuses[m["status"]] = statuses.get(m["status"], 0) + 1
print(f"{len(movies)} Filme extrahiert")
print("Bewertungen:", ratings)
print("Status:", statuses)
print("Mit Kommentar:", sum(1 for m in movies if m["comment"]))
print("Beispiele:", [m["title"] for m in movies[:3]], "...", [m["title"] for m in movies[-2:]])
