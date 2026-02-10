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

Then build:

```bash
cd nginx-1.26.3

# with cmark-gfm support (recommended)
./configure $(nginx -V 2>&1 | grep -oP 'configure arguments: \K.*') \
  --add-dynamic-module=../ngx_markdown_filter_module \
  --with-cc-opt="-DWITH_CMARK_GFM $(nginx -V 2>&1 | grep -oP -- "--with-cc-opt='\K[^']*")"

# or without GFM, plain cmark only
./configure $(nginx -V 2>&1 | grep -oP 'configure arguments: \K.*') \
  --add-dynamic-module=../ngx_markdown_filter_module

make modules
```

The compiled module will be at `objs/ngx_markdown_filter_module.so`.

### 5. Install the module

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

The template is plain HTML with a `{{content}}` placeholder. The module splits the file at `{{` and `}}`, uses everything before as header and everything after as footer, then inserts the converted HTML in between.

A minimal template:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>My Site</title>
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <div class="content">
    {{content}}
  </div>
</body>
</html>
```

You can put anything in the template: navigation, sidebars, scripts. The only rule is one `{{content}}` placeholder.

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

---
