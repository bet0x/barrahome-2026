# There Is No Silver Bullet for RAG: Different Text, Different Index

**Published on:** 2026/10/16

**Tags:** rag, postgres, pgvector, bm25, hybrid-search, embeddings, search, legal

---

I see one question about RAG all the time. Which retrieval method is best? BM25, vectors, hybrid, a re-ranker, a graph?

I think the question is wrong. It treats "your documents" as one thing. They are almost never one thing.

I am building a research product over a large body of Mexican legal text. It runs on one Postgres database with three kinds of index: native full-text search, BM25 through `pg_search`, and vectors through `pgvector`. I ran the same evaluation on two kinds of document from that corpus. The winner flipped.

This post covers that result. It also covers the boring work before the index, because that work changed my numbers more than the index did. I wrote the general overview already in [On RAG Applications: From Theory to Enterprise Setups](/2026/02/19/rag-from-theory-to-enterprise.md). This is the messier follow-up, with measurements.

## Two kinds of text, one question

Law looks uniform from far away. It is not. I search two very different things.

**Statutes** are long documents with a strict hierarchy: titles, chapters, numbered articles, sub-items. A user almost never wants the whole statute. They want one article inside it.

**Case-law headnotes** are short summaries of what a court decided. Each one has a heading, a body, and a citation identifier that lawyers paste around exactly as written. I have about 178,000 of them.

The domain is the same. The users are the same. The database is the same. The text has a different shape, and so the best retriever is different.

## What I measured

I wrote 63 queries: 38 for headnotes and 25 for statute articles. Each method returned its top 10 results. A language model graded each result from 0 (useless) to 2 (answers the question).

The baseline is the Postgres full-text search I started with. The vector model is a small multilingual embedding model with 384 dimensions. Hybrid fuses BM25 and vectors with reciprocal rank fusion. All numbers are nDCG@10.

**Case-law headnotes**

| Method | Overall | Citation identifier | Concept | Colloquial |
|---|---|---|---|---|
| Postgres full-text | 0.419 | 0.000* | 0.741 | 0.321 |
| BM25 | **0.630** | **0.845** | 0.729 | 0.416 |
| Vectors | 0.429 | 0.000 | 0.665 | 0.421 |
| Hybrid | 0.620 | 0.798 | 0.732 | 0.414 |

\* The application finds identifiers with a separate lookup. This zero does not describe what users see. The vector zero is real.

**Statute articles**

| Method | Overall | Concept | Colloquial |
|---|---|---|---|
| Postgres full-text | 0.171 | 0.163 | 0.173 |
| BM25 | 0.359 | **0.537** | 0.315 |
| Vectors | 0.418 | 0.248 | **0.460** |
| Hybrid | **0.429** | 0.413 | 0.434 |

Put the two tables side by side. On headnotes, BM25 wins and vectors add nothing. Hybrid lands slightly below BM25 alone. On articles, vectors beat BM25 and hybrid is the best. I evaluated both corpora, so I did not ship a confident and wrong rule for one of them.

The identifier column is my favorite result. A citation identifier is an opaque string. An embedding model has no reason to place it near anything, and it scored exactly zero. A lexical index that does not stem the identifier scored 0.845. You cannot tune your way out of that. The vector side is the wrong tool for that query.

The colloquial queries show the opposite. A user writes "my landlord won't return my deposit". The law says something else. This is a vocabulary gap, and embeddings exist for it. On articles, vectors lead on colloquial queries: 0.460 against 0.315 for BM25.

## Read this before you quote my numbers

I prefer that you read these limits first.

- **A language model graded the results, not a lawyer.** It may reward text that only sounds similar, and that favors vectors. The numbers compare methods with each other. They do not measure absolute quality.
- **The queries are few and an AI wrote them.** With 25 article queries, a gap of 0.05 can be noise. Only five of those are "concept" queries. So 0.537 against 0.248 is a hint, not a proof.
- **The evaluation covers only five jurisdictions** of the statute corpus.

After the experiment, I also checked 30 real queries by hand on the deployed system. On articles, the hybrid beat the previous behavior in 14 of 18 comparisons. That agrees with the lab numbers. It does not prove them.

## The biggest win was not a model

Look at the statute table again. The jump from 0.171 to 0.359 comes from BM25 alone. That result uses no embeddings. Part of that gain is BM25 ranking better than the native ranking. A larger part comes from a decision about what one row is.

My first design indexed whole statutes with Postgres `tsvector`. A `tsvector` stores word positions only up to 16,383. My database holds 6,546 visible statutes, and 1,942 of them are longer than that limit. Past the limit, the system loses the word-proximity data that `ts_rank_cd` needs. Another 21 statutes pass 1 MB and Postgres truncates them.

So the ranking worked on short laws and quietly got worse on long ones. Long laws are the ones people most need to search.

The fix was to index articles instead of statutes. Each row is one article. It carries the statute title and the jurisdiction as metadata. This is a data-model change, not a new algorithm. It moved the number more than the choice between BM25 and vectors.

The old flow found the three best whole statutes and then pulled articles out of them. If it chose the wrong statutes, it could not recover. Direct article search removes that failure.

If I could give one piece of RAG advice, it would be this: decide what one answer is before you pick an embedding model. Then index that unit. For statutes, it is an article. For headnotes, it is the whole headnote. For long court rulings, it is something else again. One chunking strategy for all of them is the quiet version of the silver bullet.

## The conversion step decides retrieval quality

None of this works if the unit is dirty. Getting a clean unit out of a government PDF is most of the work. The index amplifies whatever you give it. Here is what my conversion step must do.

- **Remove repeated letterheads and page numbers, but only the real ones.** A letterhead repeats in the header zone of most pages. A reform note that repeats on one page is content. A lone number in the body is also content, like a date split across two lines.
- **Move amendment marks out of the text.** Statutes contain many marks like "(Reformed, published on ...)". Inside the article body, they add noise to BM25 statistics and to the embedding. I move them into notes on the article. This is my reasoning, not a measurement. I did not run the ablation, so treat it as a hypothesis.
- **Fix text in capital letters.** Some sources publish whole statutes in capitals without accents. The converter restores sentence case and accents only when nearly all letters are uppercase.
- **Give each article a stable key, and parse it in one place.** "Article 27 Bis", "ARTICULO 97BIS" and "Art. 278-Bis" all become one normalized key. The importer, the index and the assistant's citations all use the same module. So I can check each citation in an answer against the corpus by exact key. A legal retrieval system that can misquote an article is not useful.
- **Treat scanned pages as unverified.** Some documents have no text layer. I run OCR page by page and compare it with the stored text. I do not trust the transcription until it passes that check.

This work is not exciting. It never appears in an embedding-model benchmark. It decides whether the system works.

## A schema does not make a parser correct

I wanted a clean way to hold a law before I index it. My converter has a JSON schema for that. It models a law as a tree of books, titles, chapters and articles. An article holds paragraphs, numbered items, sub-items and reform notes. Every node has a stable path id. A reform note records the action (amended, added, repealed) and the publication date. The Markdown is only a view that the converter renders from the JSON.

I think this is the right shape. It also fits the argument above: the article is the unit.

Then I tested it on a hard case. The Federal Civil Code is a 370-page PDF from the Chamber of Deputies. The converted JSON passed the schema with zero errors. I compared it with the PDF, and it was wrong in four ways.

- **The hierarchy was gone.** The PDF has 4 book headings, 49 title headings and 218 chapter headings. The JSON had zero books, zero titles and 2 chapters.
- **An article was missing.** The PDF has Article 4 near the start. The JSON went from Article 3 to Article 5.
- **A suffix was cut off.** "Article 28 Bis" became a heading "Article 28", and "Bis.-" moved into the body. So the key "28" appeared twice.
- **The separator leaked into the text.** In 3,082 of the 3,115 articles, the body started with ".-".

A schema checks shape. It cannot tell you that the parser found everything. So I did two things.

First, I wrote version 1.1 of the schema. Every article now needs a normalized `key`, the `page` in the original PDF and a `status` (in force or repealed). A new `parte` level sits between book and title, because this code has "PRIMERA PARTE" headings. The old JSON failed the new schema with 9,346 errors. That was the point: the old schema had no way to ask for those fields.

Second, I wrote a small checker that compares the JSON with the PDF text. It checks four things:

1. The article headings in the PDF match the article keys in the JSON.
2. No key repeats, and the numbers in the code body have no gaps.
3. Every article has a page.
4. Every book, title and chapter heading in the PDF exists as a node, and no separator or heading leaks into a body.

The checker found the problems. Then I fixed the parser. Each failure had its own cause, and none of them was the one I guessed.

**The missing article was a page-header filter.** The converter drops lines that look like a repeated page header. The pattern was case-insensitive, and it matched anywhere in the line. Article 4 says "reglamento, circular o disposición de observancia general". The pattern saw "reglamento" and "general", so the converter threw the whole article away as if it were a header. In the PDF text, about 118 lines of body text match that pattern. I confirmed that Article 4 was lost. I did not diff the other lines one by one. The fix is small. A page header is a line in capital letters that starts with the law title.

**The hierarchy was an accent.** The heading pattern knew only "TÍTULO" with an accent. This PDF prints "TITULO" and "CAPITULO" without it. The same pattern also had no "LIBRO" and no "PARTE".

**The suffix and the separator were one regex.** It read the heading up to the number and left "Bis.-" in the body. Now it reads the number, the ordinal mark and the suffix, and it drops the separator.

**Two problems showed up only after those fixes.** The code's own transitory articles start under a heading that says "ARTICULOS TRANSITORIOS", and the parser did not know it. Also, a few editorial notes quote an article of another law ("the article of that law said:"), and the parser counted the quote as an article of the code.

Here is the same checker on the same PDF, before and after.

| Check | Old JSON | New JSON |
|---|---|---|
| Article keys missing from the JSON | 28 | 0 |
| Repeated keys | 22 | 0 |
| Gaps in the numbering | 1 (Article 4) | 0, from 1 to 3074 |
| Articles with a page | 0 of 3,115 | 3,103 of 3,103 |
| Books / titles / chapters found | 0 / 0 / 2 | 4 / 49 / 219 |
| Bodies that start with a separator | 3,082 | 0 |
| Errors against the schema | 9,346 | 0 |

Look at the old column. The converter's own output passed its own schema. Only a comparison with the PDF showed that it was wrong.

I should be clear about the limits. This is one law. The parser changes touch every law the converter handles, and I did not run the other 315 federal laws again. The existing test suite passes (430 tests), but it does not replace a full run. The checker also has blind spots. For example, a note that quotes two articles in a row would still fool the parser. The new JSON has 219 chapters where my checker counts 218 in the PDF. I have not looked into that one yet.

Building RAG over a law like this is not a weekend job. Most of the work happens before any embedding exists.

## One database, three indexes, one job each

The final stack has native full-text as a fallback, BM25 for lexical ranking, and `pgvector` for semantic recall. They do not compete. Each one handles the queries it is good at.

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>Routing a Query</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
graph LR
    Q[Query] --> ID{Looks like an identifier?}
    ID -->|yes| LEX[Lexical match, no stemming]
    ID -->|no| ALL[BM25: all the words]
    ALL -->|results| OUT[Ranked answer]
    ALL -->|nothing| ANY[BM25: any word]
    ANY --> FUSE[Fuse with vectors, half weight]
    FUSE --> OUT
    LEX --> OUT
</div>
</div>
</div>

This diagram shows the headnote path. It came from a failure. When I fused vectors into headnote search at full weight, the results were junk. They were plausible rulings from the wrong area of law. At weights of 0.5 and 0.75, the results behaved.

So on headnotes, BM25 first demands all the words. Only when no headnote contains all of them, the system relaxes to any word and adds vectors at half weight. On statute articles, hybrid always runs. The policy changes per corpus, and the database stays the same.

If you build this on Postgres, these notes may save you time.

- **Keep vectors in their own tables.** A vector column next to a BM25-indexed text column makes every embedding backfill rewrite rows that the BM25 index also covers.
- **Cache embeddings by a hash of the exact text you embedded.** The text you embed is not always the text you store. You may add titles or remove annotations. I key the cache on the derived string. A vector computed on a GPU workstation then works in production, even when row ids differ.
- **Use iterative scans for filtered vector search.** With an HNSW index, a filter such as jurisdiction can leave you with a short result list. `hnsw.iterative_scan` keeps scanning until enough rows pass the filter.
- **Build the HNSW index after the bulk load.** Watch your memory settings too. With a small shared memory size, a large `maintenance_work_mem` made the build fail. 1 GB was enough.
- **Load BM25 data in small batches.** One huge insert left a search at over a second instead of about a millisecond. A `REINDEX` fixed it.
- **Choose the tokenizer per column.** Prose gets a Spanish stemmer with accent folding. Identifiers get a plain tokenizer with no stemming. The same table can use both.
- **Count the cost of embeddings.** One query costs about 12 ms on a desktop CPU with four threads. On a weak server CPU, bulk embedding runs at a few texts per second. I embed in bulk on a GPU, which does hundreds per second, and I ship the vectors to the server.

## Semlix, my other experiment

I also wrote [semlix](https://github.com/semlix/semlix) to test one idea. Maybe a single library could give me hybrid search and good speed without much setup.

Semlix is a pure-Python library, based on Whoosh. It combines lexical search (BM25 or TF-IDF) with vector search. It offers several fusion methods, including RRF. It has two lexical engines. One is a full-featured core. The other is a bm25s engine in memory. The README says the bm25s engine indexes about 40 times faster and queries about 57 times faster, but it only handles bags of words.

I have not run semlix on the evaluation in this post. So I make no claim about its quality against the Postgres stack. The question from this post still applies to it: a hybrid default is a good start, but each corpus may need its own policy.

## What I have not solved

The vocabulary gap is still open. A user writes "fees the bank charged that I did not authorize". The headnote says "unrecognized charges". BM25 misses this by construction. The small embedding model catches it only sometimes.

Query rewriting with an LLM is the obvious next experiment. I have not run it, so I will not say it helps.

## What I would tell you to do first

1. **Name your document types.** Write down the shape of each type and what one answer is. If the answer depends on the type, a single pipeline will lose somewhere.
2. **Name your query types.** Identifier lookups, exact concepts and plain-language questions want different things. The tables above show it.
3. **Build a small evaluation before you choose.** About sixty queries and an LLM judge told me things I did not expect. Check a sample by hand, and say clearly what you did not check.
4. **Fix the unit and the conversion first.** They moved my numbers more than any model choice.
5. **Route, do not pick.** Let each index do its job. Keep a fallback, so one failed component makes the answer worse and does not end it.

No retrieval method works on all of your text, because your text is not one kind. What exists is a measured fit between a shape of document, a shape of question and an index. Finding that fit is the work. You do it again when the corpus changes.

---

*AI was used for research and drafting assistance on this post.*
