# A markdown blog with nginx

**2026/02/06**

**Tags:** blog, nginx, markdown, css

Today the blog is officially up. The chosen aesthetic: retro terminal, phosphor green on black, like the CRT monitors from the 80s.

## The idea

I wanted a blog that:

1. Didn't depend on any framework
2. Could be written in plain markdown
3. Had an aesthetic consistent with the simplicity philosophy
4. Ran fast with minimal resources

The combination of nginx + a markdown module + CSS checks all the boxes.

## How it works

The flow is straightforward:

```
HTTP request -> nginx -> markdown module -> cmark converts to HTML -> CSS template -> response
```

There's no cache because there's no need. Converting markdown to HTML is a trivial operation for cmark. The result is a site that responds in microseconds.

## The Matrix style

The CSS simulates a CRT terminal with:

- Black background with phosphor green text
- Scanline effect using a repeating CSS gradient
- Text glow with `text-shadow`
- Blinking cursor in the header
- System monospace font

All without external fonts, without JavaScript (except a minimal snippet to set the page title), without dependencies.

## Writing a new post

The process is:

```bash
# create directory for the date
mkdir -p 2026/02/06/

# write the post
vim 2026/02/06/my-post.md

# add to the index
vim index.md
```

That's it. No build step, no deploy.

## What's next

We'll see. The beauty of a blog like this is that there's no pressure. A markdown file whenever there's something worth writing about.

---
