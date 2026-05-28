---
name: ads
description: >-
  Full ADS query syntax reference and search strategy for the ads_search, ads_paper, ads_citations,
  and ads_download_pdf tools. Load this before composing ADS queries — the tool descriptions only
  cover basic field prefixes. Contains: fielded search syntax, date/class filters (entdate, arxiv_class),
  citation operators, wildcards, positional search, properties, doctypes, daily arXiv listing patterns,
  and query recipes.
---

# ADS Query Syntax & Search Strategy

Reference: <https://ui.adsabs.harvard.edu/help/search/>

## Query Basics

- Space = AND, `OR`, `NOT` / `-` (exclude), `()` group, `"phrase"`
- Precedence: `NOT` > `AND` > `OR` > implicit-AND > `-`

## Fielded Search

### Text Fields

| Field | Syntax |
|-------|--------|
| Title+Abstract+Keywords | `abs:"phrase"` |
| Title only | `title:"phrase"` |
| Abstract only | `abstract:"phrase"` |
| Keywords | `keyword:"phrase"` |
| Full text (body+abs+title+ack+kw) | `full:"phrase"` |
| Body only | `body:"phrase"` |
| Acknowledgements | `ack:"phrase"` |

### Author

| Syntax | Meaning |
|--------|---------|
| `author:"Last, F"` | Greedy match (initials, variations) |
| `author:"Last, First M"` | More precise (recommended) |
| `author:"^Last, F"` | First-author only |
| `=author:"Last, F"` | Exact match, no synonym expansion |

Precision: `author:"murray, s"` (broadest) → `"murray, stephen"` → `"murray, stephen s"` (tightest)

### Identifiers & Publication

`bibcode:ID`, `doi:DOI`, `arXiv:ID`, `identifier:ID`, `bibstem:ApJ`, `volume:N`, `issue:N`, `page:N`, `year:YYYY` or `year:YYYY-YYYY`, `pubdate:[YYYY-MM TO YYYY-MM]`

### Affiliation

`aff:"phrase"` (raw), `inst:"Harvard U"` (curated, matches variants), `inst:"UCLA/IGPP"` (department), `aff_id:ID`

### Object & Position

`object:Andromeda` (SIMBAD+NED), `object:"(SMC OR LMC) AND M31"` (combined), cone search: `object:"RA Dec:radius"` (decimal deg or sexagesimal, default 2', max 60')

### Classification & Counts

`database:astronomy|physics|general`, `doctype:type`, `arxiv_class:"class"`, `property:flag`, `bibgroup:name`, `citation_count:[10 TO 100]`, `author_count:[10 TO 100]`, `read_count:N`, `facility:/regex/`, `orcid:ID`, `grant:agency`

## Synonyms & Case Sensitivity

- lowercase → matches variations + synonyms (e.g. `title:star` → star, stars, stellar…)
- UPPERCASE → acronym-only (`title:STAR` → only "STAR")
- `=field:` prefix → exact match, no synonym expansion

## Wildcards & Proximity

| Syntax | Meaning |
|--------|---------|
| `*` / `?` | Multi/single-char wildcard |
| `NEAR[N]` | ≤N words apart, any order |
| `"term1 term2"~N` | In-order proximity within N positions |
| `/regex/` | Lucene regex on indexed tokens |

## Positional Search — `pos(query, positions...)`

Works on: `author`, `aff`, `title`. Examples: `pos(author:"Oort, J", 2)` (2nd author), `pos(author:"Oort", 1,3)` (1st–3rd), `pos(author:"Oort", -1)` (last), `pos(aff:"harvard", 1)` (1st author at Harvard)

## Citation & Reference Operators

`citations(query)` = papers citing query results, `references(query)` = papers cited by query results. Nestable with other terms.

## Second-Order Operators

`similar(query)` (textually similar), `trending(query)` (read by same readers), `useful(query)` (frequently cited by results), `reviews(query)` (citing papers ranked by freq), `topn(N, query, sort)`

Tip: `similar()` excludes originals; use disjoint `entdate` ranges to control overlap.

## Properties

`refereed`, `notrefereed`, `article`, `nonarticle`, `openaccess`, `ads_openaccess`, `pub_openaccess`, `eprint_openaccess`, `author_openaccess`, `data`, `esource`, `inspire`, `toc`

## Document Types

`article`, `eprint`, `inproceedings`, `inbook`, `abstract`, `book`, `bookreview`, `catalog`, `circular`, `erratum`, `mastersthesis`, `newsletter`, `obituary`, `phdthesis`, `pressrelease`, `proceedings`, `proposal`, `software`, `talk`, `techreport`, `misc`

## Bibliographic Groups

Institutional: ARI, CfA, CFHT, Leiden, USNO | Telescope: ALMA, CXC, ESO, Gemini, Herschel, HST, ISO, IUE, JCMT, Keck, Magellan, NOIRLab, NRAO, ROSAT, SDO, SMA, Spitzer, Subaru, Swift, UKIRT, XMM

## Daily arXiv Listings

Use `entdate` (day-resolution) with `doctype:eprint` and `arxiv_class`. Note: `pubdate` is month-resolution only.

```
# Today's astro-ph.CO (±2 day window)
arxiv_class:"astro-ph.CO" entdate:[2026-04-07 TO 2026-04-09] doctype:eprint

# All astro-ph classes
arxiv_class:("astro-ph.CO" OR "astro-ph.GA" OR "astro-ph.HE" OR "astro-ph.IM" OR "astro-ph.EP" OR "astro-ph.SR") entdate:[2026-04-07 TO 2026-04-09] doctype:eprint
```

Subclasses: `CO` (Cosmology), `EP` (Earth & Planetary), `GA` (Galaxy Astrophysics), `HE` (High Energy), `IM` (Instrumentation), `SR` (Solar & Stellar).

## Search Strategy: Simplicity First

- Start with 2–3 core nouns. If too many results, add constraints (year, author, title:). Don't start with a sentence.
- ADS is keyword/metadata matching, not semantic search. Overloading queries kills recall.
- Use `detail='full'` on fewer results rather than compact on many — abstracts often contain the answer.

### Common Pitfalls

**1. Compound multi-concept queries → zero results.**
Fix: 1–2 core terms + `sort_by` + `year_from:`. Scan abstracts for specifics.
```
# Bad: "Population III He II helium 1640 JWST metal-poor galaxy candidate"
# Good: "Population III JWST"  sort_by:date  year_from:2024
```

**2. Non-article doctypes polluting results.**
Fix: `doctype:article` or `property:refereed`.

**3. Iterative reformulation without simplifying.**
If 2+ zero-result queries on the same topic: strip to 1–2 broadest terms, or use `web_search` first to find titles/authors, then look up in ADS.

**4. Use `web_search` → ADS as a two-step pipeline.**
For complex/emerging topics, start with `web_search` (plural `queries`, 2–4 varied angles) to identify key papers/arXiv IDs, then verify via `ads_paper` or targeted `ads_search`.

### When Keyword Search Fails, Use Citation Networks

For interdisciplinary connections, find a known paper then walk citations (`ads_citations`) or references. Citation chains beat keyword matching for cross-domain discovery.

## Quick Query Recipes

```
# Recent refereed articles on a topic
abs:"dark energy" year:2023-2025 property:refereed doctype:article

# Papers by first author at an institution
author:"^smith, john" inst:"MIT"

# Highly-cited reviews
reviews("machine learning astronomy") property:refereed

# Papers citing a specific work, sorted by citations
citations(bibcode:2023ApJ...950L..12A) sort:citation_count

# Object in specific journal
object:Andromeda bibstem:ApJ

# Open access with data links
property:openaccess property:data keyword:"gravitational waves"

# Exclude preprints, keep only journal articles
abs:"transiting exoplanet" doctype:article -arxiv_class:*

# Cone search
object:"12h30m49.4s +12d29m40s:5"
```
