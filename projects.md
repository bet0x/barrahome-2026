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

📄 **License:** MIT

💻 **Repo:** [github.com/bet0x/ngx_markdown_filter_module](https://github.com/bet0x/ngx_markdown_filter_module)

---

## barrahome-2026

The source for this site. A markdown-only blog served by nginx using `ngx_markdown_filter_module` — no static generator, no build step, no framework. You write `.md` files, nginx serves them as HTML.

The stack:

- **nginx** + `ngx_markdown_filter_module` for markdown rendering
- **A single bash script** (`barrahome_blog_gen.sh`) to generate the post index
- **CSS** styled as a retro CRT terminal with CDE Motif window decorations
- Posts organized by date path: `/YYYY/MM/DD/post.md`

The entire publishing workflow is: write a `.md` file, run the index generator, commit, push.

💻 **Repo:** [github.com/bet0x/barrahome-2026](https://github.com/bet0x/barrahome-2026)

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

📄 **License:** BSD 2-Clause

📦 **PyPI:** [pypi.org/project/semlix](https://pypi.org/project/semlix/)

📖 **Docs:** [semlix.readthedocs.io](https://semlix.readthedocs.io/)

💻 **Repo:** [github.com/semlix/semlix](https://github.com/semlix/semlix)

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

📄 **License:** MIT

💻 **Repo:** [github.com/bet0x/broadcom_crawler](https://github.com/bet0x/broadcom_crawler)

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

💻 **Repo:** [github.com/bet0x/readability-server](https://github.com/bet0x/readability-server)

---

## docling-serve-sdk

A Python SDK for the Docling Serve API. Type-safe document conversion with Pydantic models, async and sync support, and built-in connection pooling and retries.

Features:

- Convert between 11+ document formats: PDF, DOCX, PPTX, HTML, images, and more
- Multiple input sources: local files, HTTP URLs, S3
- Configurable OCR engines and PDF backends
- Hierarchical and hybrid document chunking
- Table extraction
- Async-first with httpx, full sync support as well
- Custom error handling and retry logic

Available on PyPI: `pip install docling-serve-sdk`

📄 **License:** MIT

📦 **PyPI:** [pypi.org/project/docling-serve-sdk](https://pypi.org/project/docling-serve-sdk/)

💻 **Repo:** [github.com/bet0x/docling-serve-sdk](https://github.com/bet0x/docling-serve-sdk)

---

## unsloth-docker

A Docker environment for fine-tuning large language models using the Unsloth framework with GPU acceleration. Ships with Mistral Small 24B Instruct as the default model but works with any Hugging Face model.

Features:

- Automatic Unsloth installation at startup
- CUDA/GPU acceleration out of the box
- Jupyter Notebook and JupyterLab interfaces for interactive training
- Hugging Face model cache mounting to save bandwidth and startup time
- Optional Flash Attention for enhanced performance
- Multiple runtime modes: bash shell, Jupyter, or JupyterLab

Available on Docker Hub: `barrahome/unsloth-docker`

📄 **License:** Apache-2.0

💻 **Repo:** [github.com/bet0x/unsloth-docker](https://github.com/bet0x/unsloth-docker)

---

## openwebui-migrator

A Python tool for migrating Open WebUI's SQLite database to PostgreSQL. Handles schema conversion, data type mapping, JSON fields, arrays, reserved keywords, and integrity checks — so you don't have to do it manually.

Features:

- Complete schema migration from SQLite to PostgreSQL
- Automatic data type conversion and mapping
- Transaction-based safety with rollback on failure
- Skips pre-populated tables to prevent duplication
- Handles reserved SQL keywords and special characters
- Comprehensive logging for debugging

Migrates all core Open WebUI tables: users, auth, chats, files, channels, and configuration.

📄 **License:** Apache-2.0

💻 **Repo:** [github.com/bet0x/openwebui-migrator](https://github.com/bet0x/openwebui-migrator)

---

## manwrapper

A simple Python command-line utility for viewing man pages in a straightforward, user-friendly way. No need to remember `man` command flags — just install and use.

Available on PyPI: `pip install manwrapper`

📄 **License:** MIT

📦 **PyPI:** [pypi.org/project/manwrapper](https://pypi.org/project/manwrapper/)

💻 **Repo:** [github.com/bet0x/manwrapper](https://github.com/bet0x/manwrapper)

---

## bpaste

A private, self-hosted pastebin service for the command line. Post, retrieve, update, and delete text snippets via HTTP with basic authentication. A simple alternative to public pastebins when you want to keep your data on your own server.

Features:

- HTTP basic authentication for access control
- Multiple posting methods: file upload, stdin, direct strings
- Full CRUD operations on pastes
- Shell script wrapper for easy CLI usage
- Flat-file database storage (Lazer Database) — no SQL needed

Built with PHP and a shell wrapper. Inspired by [cmdpb](https://github.com/KnightOS/cmdpb).

📄 **License:** GPL-3.0

💻 **Repo:** [github.com/bet0x/bpaste](https://github.com/bet0x/bpaste)

---

## Hyper-V-Web-Console

A web-based console for managing Microsoft Hyper-V virtual machines from the browser. Monitor and control VMs without needing RDP or the native Hyper-V Manager.

Features:

- Display virtual machine information
- Start, restart, and stop VMs
- HTTP basic authentication
- Web interface served from localhost

Built with Go and HTML/CSS/JS. Requires Windows with Hyper-V and PowerShell modules.

📄 **License:** GPL-3.0

💻 **Repo:** [github.com/bet0x/Hyper-V-Web-Console](https://github.com/bet0x/Hyper-V-Web-Console)
