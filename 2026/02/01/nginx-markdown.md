# Setting up nginx to serve markdown

**2026/02/01**

**Tags:** nginx, markdown, linux

One of the goals for this site was to avoid any static generator. I don't want to run `hugo build` or `jekyll serve` every time I write something. The solution: an nginx module that converts markdown to HTML on the fly.

## The ngx_markdown_filter_module

The [ngx_markdown_filter_module](https://github.com/bet0x/ngx_markdown_filter_module) uses the **cmark** library (or its **cmark-gfm** variant) to parse markdown and return HTML. It compiles as a dynamic nginx module.

The basic configuration is simple:

```nginx
location ~ \.md$ {
    markdown_filter on;
    markdown_template templates/markdown_template.html;
}
```

With that, any `.md` file served by nginx is automatically converted to HTML and wrapped in the template.

## The template

The template is a regular HTML file with a `{{content}}` placeholder where the converted markdown is inserted. This allows having a consistent layout with CSS, header, footer, etc.

## Post structure

Posts are organized by date in the path:

```
/YYYY/MM/DD/title.md
```

There is no automatic index. The post list is maintained manually in `index.md`. It's a limitation, but also a choice: less magic, more control.

## GFM extensions

If the module is compiled with cmark-gfm support, extensions can be enabled:

- `markdown_gfm_autolink on;` - URLs are automatically converted to links
- `markdown_gfm_strikethrough on;` - ~~strikethrough~~ text
- `markdown_gfm_tasklist on;` - task lists with checkboxes

## Result

A blog that is basically a directory with `.md` files. No builds, no deploys, no hassle. Editing a post is editing a text file. Publishing is creating a new file and adding a line to the index.

---
