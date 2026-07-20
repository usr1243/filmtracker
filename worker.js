// Filmtracker API — Cloudflare Worker + KV (Single-User, kein Auth per Design-Entscheidung)
// Daten liegen als ein JSON-Blob im KV-Namespace FILM_STATE unter dem Key "state".

const KEY = "state";
const RATINGS = ["LOVE", "LIKE", "MEH", "DISLIKE", "QUEUE"];
const STATUSES = ["Nachgeschaut", "Noch nicht geschaut"];
// TMDb v3 API-Key — als Cloudflare-Secret hinterlegt (`wrangler secret put TMDB_KEY`),
// läuft nur server-seitig und wird NIE an den Browser gesendet.
// Lokal: in .dev.vars als TMDB_KEY setzen (siehe .dev.vars.example).

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function loadState(env) {
  const raw = await env.FILM_STATE.get(KEY);
  return raw ? JSON.parse(raw) : { movies: [], nextId: 1 };
}

const saveState = (env, state) => env.FILM_STATE.put(KEY, JSON.stringify(state));

function cleanMovie(input, id) {
  return {
    id,
    title: String(input.title || "").trim().slice(0, 300),
    rating: RATINGS.includes(input.rating) ? input.rating : "QUEUE",
    status: STATUSES.includes(input.status) ? input.status : "Noch nicht geschaut",
    updated: new Date().toISOString().slice(0, 19).replace("T", " "),
    comment: String(input.comment || "").slice(0, 2000),
    genre: String(input.genre || "").slice(0, 200),
    overview: String(input.overview || "").slice(0, 2000),
    poster: String(input.poster || "").slice(0, 200),
    year: String(input.year || "").slice(0, 4),
    enriched: !!input.enriched,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      // GET /api/state — kompletter Datenbestand (nur Filme, keine internen Felder)
      if (path === "/api/state" && request.method === "GET") {
        const state = await loadState(env);
        return json({ movies: state.movies, nextId: state.nextId });
      }

      // POST /api/movies — neuen Film anlegen
      if (path === "/api/movies" && request.method === "POST") {
        const body = await request.json();
        if (!String(body.title || "").trim()) return json({ error: "Titel fehlt" }, 400);
        const state = await loadState(env);
        const movie = cleanMovie(body, state.nextId++);
        state.movies.push(movie);
        await saveState(env, state);
        return json(movie, 201);
      }

      // PUT/DELETE /api/movies/:id
      const idMatch = path.match(/^\/api\/movies\/(\d+)$/);
      if (idMatch) {
        const id = Number(idMatch[1]);
        const state = await loadState(env);
        const idx = state.movies.findIndex((m) => m.id === id);
        if (idx === -1) return json({ error: "Film nicht gefunden" }, 404);

        if (request.method === "DELETE") {
          state.movies.splice(idx, 1);
          await saveState(env, state);
          return json({ ok: true });
        }
        if (request.method === "PUT") {
          const body = await request.json();
          const old = state.movies[idx];
          const merged = cleanMovie({ ...old, ...body }, id);
          state.movies[idx] = merged;
          await saveState(env, state);
          return json(merged);
        }
      }

      // POST /api/import — { movies: [...], mode: "merge" | "replace" }
      // merge: gleicht per Titel ab (Groß/Klein egal), aktualisiert Bewertung/Status/Kommentar,
      //        legt unbekannte Titel neu an, löscht nichts. replace: ersetzt alles.
      if (path === "/api/import" && request.method === "POST") {
        const body = await request.json();
        if (!Array.isArray(body.movies)) return json({ error: "movies fehlt" }, 400);
        const state = await loadState(env);
        let added = 0, updated = 0;

        if (body.mode === "replace") {
          state.movies = [];
          state.nextId = 1;
        }
        // replace: alle Zeilen 1:1 übernehmen (gleiche Titel = z.B. Remakes bleiben getrennt)
        // merge: per Titel abgleichen, nichts löschen
        const byTitle = new Map(state.movies.map((m) => [m.title.toLowerCase(), m]));
        for (const raw of body.movies) {
          const title = String(raw.title || "").trim();
          if (!title) continue;
          const existing = body.mode === "replace" ? null : byTitle.get(title.toLowerCase());
          if (existing) {
            if (raw.rating && RATINGS.includes(raw.rating)) existing.rating = raw.rating;
            if (raw.status && STATUSES.includes(raw.status)) existing.status = raw.status;
            if (raw.comment) existing.comment = String(raw.comment).slice(0, 2000);
            updated++;
          } else {
            const movie = cleanMovie(raw, state.nextId++);
            if (raw.updated) movie.updated = String(raw.updated).slice(0, 30);
            state.movies.push(movie);
            byTitle.set(title.toLowerCase(), movie);
            added++;
          }
        }
        await saveState(env, state);
        return json({ ok: true, added, updated, total: state.movies.length });
      }

      // Genre-Namen für eine Liste TMDb-Genre-IDs (Liste wird im State gecacht)
      async function genreNames(state, ids) {
        if (!state.genreCache) {
          const [gm, gt] = await Promise.all([
            fetch("https://api.themoviedb.org/3/genre/movie/list?language=de-DE&api_key=" + env.TMDB_KEY).then((r) => r.json()),
            fetch("https://api.themoviedb.org/3/genre/tv/list?language=de-DE&api_key=" + env.TMDB_KEY).then((r) => r.json()),
          ]);
          state.genreCache = {};
          for (const g of [...(gm.genres || []), ...(gt.genres || [])]) state.genreCache[g.id] = g.name;
        }
        return (ids || []).map((id) => state.genreCache[id]).filter(Boolean).join(", ");
      }

      // Bester Treffer für einen Titel. Verhindert, dass bei mehrdeutigen Titeln (Remakes,
      // gleichnamige alte Filme, andere Sprachversionen) ein zufälliger/unpassender Treffer
      // genommen wird. Verfahren (jede Stufe nur falls die vorige nichts Eindeutiges liefert):
      //   1. Titel exakt getroffen (Titel ODER Originaltitel, wegen deutscher Lokalisierung
      //      wie "Riddick - Chroniken eines Kriegers" für "The Chronicles of Riddick") —
      //      gewinnt, außer ein Teiltreffer hat >20x mehr Stimmen (echtes Bekanntheitssignal,
      //      `popularity` ist zu tagesaktuell/volatil für diesen Zweck).
      //   2. Bester Teiltreffer (Substring in beide Richtungen, mind. 4 Zeichen Query-Länge).
      //   3. Fallback: meiste Stimmen unter allen Treffern.
      // Nicht-lateinische Titel (z.B. Koreanisch) normalisieren zu "" — müssen ausgeschlossen
      // werden, sonst ist "" trivial Teilstring von allem und erzeugt Fehltreffer.
      function bestMatch(results, title) {
        const norm = (s) => String(s || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
        const q = norm(title);
        const candidates = (results || []).filter((r) => r.media_type === "movie" || r.media_type === "tv");
        if (!candidates.length) return null;
        const namesOf = (r) => [r.title, r.name, r.original_title, r.original_name].filter(Boolean).map(norm).filter(Boolean);
        const votes = (r) => r.vote_count || 0;
        const isExact = (r) => namesOf(r).some((n) => n === q);
        const isNear = (r) => q.length >= 4 && namesOf(r).some((n) => q.includes(n) || n.includes(q));
        const maxBy = (arr, fn) => arr.reduce((best, r) => (fn(r) > fn(best) ? r : best), arr[0]);
        const exact = candidates.filter(isExact);
        const near = candidates.filter(isNear);
        const bestExact = exact.length ? maxBy(exact, votes) : null;
        const bestNear = near.length ? maxBy(near, votes) : null;
        if (bestExact && votes(bestExact) > 0 && votes(bestExact) * 20 >= votes(bestNear || {})) return bestExact;
        if (bestNear) return bestNear;
        return maxBy(candidates, votes);
      }

      // Einen Film via TMDb anreichern (mutiert das Objekt). true = Treffer, false = kein Treffer.
      async function enrichMovie(state, movie) {
        const res = await fetch(
          "https://api.themoviedb.org/3/search/multi?language=de-DE&query=" +
            encodeURIComponent(movie.title) + "&api_key=" + env.TMDB_KEY
        );
        if (!res.ok) throw new Error("TMDb-Fehler " + res.status);
        const data = await res.json();
        const hit = bestMatch(data.results, movie.title);
        if (!hit) return false;
        movie.genre = await genreNames(state, hit.genre_ids);
        movie.overview = String(hit.overview || "").slice(0, 2000);
        movie.poster = hit.poster_path || "";
        movie.year = (hit.release_date || hit.first_air_date || "").slice(0, 4);
        return true;
      }

      // POST /api/enrich/:id — einen Film anreichern
      const enrichMatch = path.match(/^\/api\/enrich\/(\d+)$/);
      if (enrichMatch && request.method === "POST") {
        const state = await loadState(env);
        const movie = state.movies.find((m) => m.id === Number(enrichMatch[1]));
        if (!movie) return json({ error: "Film nicht gefunden" }, 404);
        let found = false;
        try { found = await enrichMovie(state, movie); } finally { movie.enriched = true; }
        await saveState(env, state);
        return found ? json({ ok: true, movie }) : json({ ok: false, notFound: true, title: movie.title });
      }

      // POST /api/enrich-batch — verarbeitet die nächsten fehlenden Filme (bounded, wegen Worker-Subrequest-Limit)
      // Antwort sagt, wie viele noch übrig sind → Client ruft solange auf, bis remaining = 0.
      // ?force=1 → ignoriert `enriched` und läuft über ALLE Filme (Re-Match mit verbessertem Algorithmus).
      // ?offset=N → Fortsetzungspunkt bei force-Läufen (batch-weise, da Worker-Subrequest-Limit).
      if (path === "/api/enrich-batch" && request.method === "POST") {
        const state = await loadState(env);
        const force = url.searchParams.get("force") === "1";
        const offset = Number(url.searchParams.get("offset") || 0);
        const pending = force ? state.movies.slice(offset) : state.movies.filter((m) => !m.enriched);
        const batch = pending.slice(0, 25);
        let done = 0, notFound = 0;
        const changes = [];
        for (const movie of batch) {
          const before = { genre: movie.genre, overview: movie.overview, poster: movie.poster, year: movie.year };
          try { (await enrichMovie(state, movie)) ? done++ : notFound++; }
          catch { notFound++; }
          movie.enriched = true; // auch bei "kein Treffer" markieren, sonst Endlosschleife
          if (force && (before.poster !== movie.poster || before.overview !== movie.overview)) {
            changes.push({ id: movie.id, title: movie.title, before, after: { genre: movie.genre, overview: movie.overview, poster: movie.poster, year: movie.year } });
          }
        }
        await saveState(env, state);
        const remaining = force ? pending.length - batch.length : pending.length - batch.length;
        return json({ ok: true, done, notFound, processed: batch.length, remaining, nextOffset: offset + batch.length, changes });
      }

      // GET /api/search?q= — durchsucht die TMDb-Bibliothek (Key bleibt server-seitig).
      // Liefert Kandidaten zum Hinzufügen; markiert, was schon in der eigenen Liste ist.
      if (path === "/api/search" && request.method === "GET") {
        const q = (url.searchParams.get("q") || "").trim();
        if (q.length < 2) return json({ results: [] });
        const state = await loadState(env);
        const res = await fetch(
          "https://api.themoviedb.org/3/search/multi?language=de-DE&include_adult=false&query=" +
            encodeURIComponent(q) + "&api_key=" + env.TMDB_KEY
        );
        if (!res.ok) return json({ error: "TMDb-Fehler " + res.status }, 502);
        const data = await res.json();
        const owned = new Set(state.movies.map((m) => m.title.trim().toLowerCase()));
        const results = [];
        for (const r of (data.results || [])) {
          if (r.media_type !== "movie" && r.media_type !== "tv") continue;
          const title = r.title || r.name || "";
          if (!title) continue;
          // Gegen alle Titel-Varianten prüfen (nicht nur den lokalisierten Titel) — TMDb liefert bei
          // language=de-DE oft einen deutschen Titel ("Der Soldat James Ryan"), die Bibliothek speichert
          // aber meist den englischen ("Saving Private Ryan"). Ohne original_title/-name würde das als
          // "nicht in Liste" durchrutschen, obwohl der Film längst vorhanden ist.
          const variants = [r.title, r.name, r.original_title, r.original_name]
            .filter(Boolean).map((t) => t.trim().toLowerCase());
          results.push({
            title,
            year: (r.release_date || r.first_air_date || "").slice(0, 4),
            poster: r.poster_path || "",
            overview: String(r.overview || "").slice(0, 2000),
            genre: await genreNames(state, r.genre_ids),
            mediaType: r.media_type,
            popularity: r.popularity || 0,
            inLibrary: variants.some((v) => owned.has(v)),
          });
          if (results.length >= 16) break;
        }
        // Neueste zuerst, älteste zuletzt (unbekanntes Jahr zählt als ältestes).
        results.sort((a, b) => (b.year || "0").localeCompare(a.year || "0"));
        return json({ results });
      }

      return json({ error: "Unbekannter Endpoint" }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
