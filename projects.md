# Projects

---

## ngx_markdown_filter_module

An nginx filter module that converts markdown files to HTML on the fly. It uses the **cmark** library (or **cmark-gfm** for GitHub Flavored Markdown support) to parse and render markdown directly from nginx, without any static site generator or build step.

Features:

- Real-time markdown to HTML conversion at the nginx level
- GFM extensions: autolink, strikethrough, tasklist, tagfilter, tables
- HTML template support with `{{content}}` placeholder
- Works on proxy locations
- Written in C, compiled as a dynamic nginx module

Fork of [ukarim/ngx_markdown_filter_module](https://github.com/ukarim/ngx_markdown_filter_module) with added GFM and table support.

**License:** MIT
**Repo:** [github.com/bet0x/ngx_markdown_filter_module](https://github.com/bet0x/ngx_markdown_filter_module)

---

## barrahome-2026

The source for this site. A markdown-only blog served by nginx using `ngx_markdown_filter_module` — no static generator, no build step, no framework. You write `.md` files, nginx serves them as HTML.

The stack:

- **nginx** + `ngx_markdown_filter_module` for markdown rendering
- **A single bash script** (`barrahome_blog_gen.sh`) to generate the post index
- **CSS** styled as a retro CRT terminal with CDE Motif window decorations
- Posts organized by date path: `/YYYY/MM/DD/post.md`

The entire publishing workflow is: write a `.md` file, run the index generator, commit, push.

**Repo:** [github.com/bet0x/barrahome-2026](https://github.com/bet0x/barrahome-2026)

---

## semlix

A pure-Python full-text indexing and search library with semantic search capabilities, built on top of Whoosh. It combines traditional keyword matching (BM25/TF-IDF) with AI-powered semantic vector search, so a query like "authentication problems" can match documents containing "login issues" even without shared keywords.

Features:

- Hybrid search merging lexical and semantic vector approaches
- Multiple embedding providers: sentence-transformers, OpenAI, Cohere, HuggingFace
- Flexible vector stores: NumPy and FAISS backends
- Result fusion algorithms: RRF, Linear, DBSF
- Fielded indexing, pluggable scoring (BM25F), spell-checking
- Pure Python — no compilation required
- Backward compatible with Whoosh

Available on PyPI: `pip install semlix[semantic]`

**License:** BSD 2-Clause
**Docs:** [semlix.readthedocs.io](https://semlix.readthedocs.io/)
**Repo:** [github.com/semlix/semlix](https://github.com/semlix/semlix)

---

## broadcom_crawler

A Python crawler that automates downloading Broadcom technical documentation and converts it to clean Markdown files with structured metadata. Designed to make vendor docs accessible for RAG pipelines and AI-augmented research.

Features:

- Recursive crawling of Broadcom documentation pages
- HTML to Markdown conversion with clean output
- Hierarchical organization: `docs/<product>/<version>/<section>/<page>.md`
- YAML frontmatter with source URL, product, version, and breadcrumbs
- TOC extraction from dynamic JSON endpoints
- Built-in rate limiting and preview mode
- Kubernetes deployment configs included

**License:** MIT
**Repo:** [github.com/bet0x/broadcom_crawler](https://github.com/bet0x/broadcom_crawler)

---

## readability-server

A REST API server that wraps Mozilla Readability to extract clean, readable content from web pages. Send it a URL, get back the article content in HTML, Markdown, or plain text — with metadata like title, author, and publication date.

Features:

- Multiple output formats: HTML, Markdown, plain text
- Rate limiting, compression, and security headers for production use
- Interactive API docs via Scalar and Swagger UI
- Health checks and metrics endpoints
- Optional API key authentication
- Docker support with pre-built images on Docker Hub (`barrahome/readability-server`)

Built with Node.js, Express, and Mozilla Readability.

**Repo:** [github.com/bet0x/readability-server](https://github.com/bet0x/readability-server)
