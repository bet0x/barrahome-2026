# Setting up ngx_markdown_filter_module: a practical guide

**Published on:** 2026/02/06

**Tags:** nginx, markdown, linux, tutorial, debian

This is a walkthrough on getting [ngx_markdown_filter_module](https://github.com/bet0x/ngx_markdown_filter_module) running on Debian, including a fix I contributed upstream and some tips I picked up along the way.

## What this module does

It hooks into nginx's output filter chain and converts `.md` files to HTML on the fly using **cmark** (or **cmark-gfm**). No build step, no static site generator. You drop a markdown file in your web root and nginx serves it as a styled HTML page.

## Building on Debian (the full process)

### 1. Install dependencies

```bash
# build tools
apt install build-essential dpkg-dev devscripts

# cmark libraries (pick one or both)
apt install libcmark-dev                # plain cmark
apt install libcmark-gfm-dev            # cmark-gfm (tables, strikethrough, etc.)

# nginx build deps
apt build-dep nginx
```

### 2. Get the nginx source

Use the exact version that matches your installed nginx:

```bash
nginx -v
# nginx version: nginx/1.26.3

apt source nginx
cd nginx-1.26.3
```

### 3. Clone the module

```bash
git clone https://github.com/bet0x/ngx_markdown_filter_module.git
```

### 4. Build the dynamic module

The key is using `--with-compat` so the module matches your existing nginx binary. Grab the configure flags from your running nginx:

```bash
nginx -V 2>&1 | grep 'configure arguments'
```

Then build. Don't drop the flags straight into `$(...)` — the dump contains quoted, space-separated values like `--with-cc-opt='-g -O2 ...'`, and unquoted command substitution word-splits the result without honoring those embedded quotes, so `configure` chokes on a bare `-O2`. Assemble the full command as one string first, then `eval` it once so the quotes get re-parsed correctly:

```bash
cd nginx-1.26.3

# with cmark-gfm support (recommended)
ORIG_ARGS=$(nginx -V 2>&1 | grep -oP 'configure arguments: \K.*')
ORIG_CC_OPT=$(nginx -V 2>&1 | grep -oP -- "--with-cc-opt='\K[^']*")
CMD="./configure $ORIG_ARGS --add-dynamic-module=../ngx_markdown_filter_module --with-cc-opt='-DWITH_CMARK_GFM $ORIG_CC_OPT'"
eval "$CMD"

# or without GFM, plain cmark only
eval ./configure $(nginx -V 2>&1 | grep -oP 'configure arguments: \K.*') \
  --add-dynamic-module=../ngx_markdown_filter_module

make modules
```

The compiled module will be at `objs/ngx_markdown_filter_module.so`.

### 5. Install the module

First time (module not loaded by any running nginx process yet), a plain copy is fine:

```bash
cp objs/ngx_markdown_filter_module.so /usr/lib/nginx/modules/

# create module loader
echo 'load_module modules/ngx_markdown_filter_module.so;' \
  > /etc/nginx/modules-available/mod-markdown.conf

# enable it
ln -s /etc/nginx/modules-available/mod-markdown.conf \
  /etc/nginx/modules-enabled/50-mod-markdown.conf

nginx -t && systemctl reload nginx
```

**Upgrading an already-loaded module is different, and this is the part that bit me.** `cp` onto an existing file overwrites it in place — same inode, new bytes underneath a shared library the running master process already has memory-mapped. Shared libraries are lazily paged in, so you end up with some code pages from the old build still resident and others getting faulted in fresh from the new build the moment something touches them. Same process, two different compiled layouts, sharing one address space. Every worker that hits the module segfaults, on a loop.

`systemctl reload` won't save you either — nginx's dynamic module loader caches by path, so a reload doesn't make it re-`dlopen` a module it already has open.

The safe way:

```bash
# write to a temp file, then atomically rename it into place —
# anyone with the old file already open keeps a consistent mapping
install -m 755 objs/ngx_markdown_filter_module.so \
  /usr/lib/nginx/modules/ngx_markdown_filter_module.so.new
mv -f /usr/lib/nginx/modules/ngx_markdown_filter_module.so.new \
  /usr/lib/nginx/modules/ngx_markdown_filter_module.so

nginx -t && systemctl restart nginx   # restart, not reload
```

A full restart, not a reload, is the point — it gets you a fresh master process that opens the file from disk with nothing stale mapped.

## The nginx config

Basic setup:

```nginx
location ~ \.md$ {
    markdown_filter on;
    markdown_template /path/to/template.html;
}
```

With GFM extensions enabled:

```nginx
location ~ \.md$ {
    markdown_filter on;
    markdown_template /path/to/template.html;
    markdown_gfm_autolink on;
    markdown_gfm_strikethrough on;
    markdown_gfm_tasklist on;
}
```

## The template

The template is plain HTML with a `{{content}}` placeholder. The module splits the file at `{{content}}`, uses everything before as header and everything after as footer, then inserts the converted HTML in between.

Two more placeholders were added later, useful for anything beyond a single static page:

- `{{title}}` — the first `<h1>` in the rendered output, falling back to the URL's filename if there's no heading.
- `{{description}}` — the first real paragraph, falling back to an empty string. "Real" skips any paragraph that's just a bold label ending in a colon (`**Published on:**`, `**Tags:**`, or your own convention), so post metadata lines don't end up as the description.

A minimal template using all three:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>{{title}}</title>
  <meta name="description" content="{{description}}">
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <div class="content">
    {{content}}
  </div>
</body>
</html>
```

You can put anything in the template: navigation, sidebars, scripts. `{{content}}` is required; `{{title}}` and `{{description}}` are optional and can appear anywhere, including more than once.

## Using index.md as your homepage

```nginx
location / {
    index index.md index.html;
    try_files $uri $uri/ /index.md;
}
```

## Tips

- **Template caching**: the module loads the template into memory at startup. After editing the template, `systemctl reload nginx` is required. Markdown files themselves are read fresh on every request.

- **404 fallback for .md files**: requests to non-existent `.md` files match `location ~ \.md$` before reaching `location /`, so `try_files` there won't help. Add it inside the markdown location:

```nginx
location ~ \.md$ {
    try_files $uri /index.md;
    markdown_filter on;
    markdown_template /path/to/template.html;
}
```

- **Raw HTML in markdown**: cmark escapes HTML tags by default. Enable `markdown_unsafe on;` if you need to embed raw HTML.

- **Content-Type**: the module sets `text/html;charset=utf-8` automatically.

- **Debian upgrades**: when nginx gets a package update, the module may need recompilation if the ABI changed. Keep your nginx source tree around.

- **Escaping in `{{title}}`/`{{description}}`**: text pulled from the rendered HTML (the `<h1>`, the first paragraph) is already HTML-escaped by cmark — don't escape it again in anything downstream. The one place that does need escaping is the URL-filename fallback for `{{title}}`, since that comes from the unescaped request path.

---
