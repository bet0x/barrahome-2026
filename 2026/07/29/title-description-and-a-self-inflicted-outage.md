# Title, Description, and a Self-Inflicted Outage

**Published on:** 2026/07/29

**Tags:** nginx, markdown, seo, incident, debugging

The [original markdown-blog post](/2026/02/06/markdown-blog.md) described the setup as: nginx receives a request, the markdown module hands it to cmark, cmark returns HTML, a template wraps it, done. That's still true, but it undersold how thin the template layer was. Every page shared the same `<meta name="description">` and `og:description`: just the post title, repeated. Fine for a retro-terminal blog with twenty-something posts. Not fine if you want search results and link previews to say something about the actual post.

## The feature

`ngx_markdown_filter_module` already had a `{{content}}` placeholder for the rendered HTML. I added two more:

- `{{title}}` — the first `<h1>` in the rendered output, falling back to the URL's filename if there's no heading.
- `{{description}}` — the first real paragraph, falling back to an empty string.

"First real paragraph" needed a second look. Every post here starts:

```
# Title

**Published on:** 2026/07/29

**Tags:** nginx, markdown, seo, incident, debugging
```

A naive "grab the first `<p>`" grabs `Published on: 2026/07/29`. Not useless, but not a description either. The fix skips any paragraph that's just a bold label ending in a colon — `**Published on:**`, `**Tags:**`, or anyone else's `**Whatever:**` convention — and keeps looking until it finds one that isn't. No hardcoded English strings, just a pattern: bold label, colon, then real content.

Template went from this:

```html
<meta name="description" content="{{title}} - barrahome.org" />
<meta property="og:description" content="{{title}} - barrahome.org" />
```

to this:

```html
<meta name="description" content="{{description}}" />
<meta property="og:description" content="{{description}}" />
```

## The part where I took the site down

Rebuilding the nginx module is normally: recompile the `.so`, copy it over the old one, reload nginx. I did exactly that. I also learned, the hard way, why you don't `cp` a shared library that's currently loaded into a running process.

`cp` onto an existing file overwrites it in place — same inode, new bytes. nginx's master process had that `.so` memory-mapped from months earlier, and shared libraries are lazily paged in: code you haven't executed yet doesn't get read from disk until the first time you jump to it. So the moment I overwrote the file, the running process ended up with some pages from the old build already resident and other pages about to be faulted in fresh from the new build the instant something touched them. Two different compiled layouts, sharing one address space. Every worker that touched the module crashed with `SIGSEGV`, nginx respawned them, the new ones crashed too, on a loop, roughly every fifteen seconds, for the better part of twenty minutes, on a live site.

`systemctl reload` didn't help, because nginx's dynamic module loader caches by path — asking it to reload doesn't make it re-`dlopen` something it already has open. What actually fixed it was the master process itself finally segfaulting hard enough that `systemd` restarted the whole service. A fresh master process, freshly opening the file from disk with nothing stale mapped, loaded cleanly.

The correct way to deploy a `.so` a running process might have open: write the new file somewhere else, then atomically rename it into place, so anyone with the old file already open keeps their old (consistent) mapping until they naturally restart. Or just skip the cleverness and restart the process. I now do both — atomic rename, then a real restart, not a reload.

## What's actually live now

Same post, checked after the fix:

```html
<meta name="description" content="&quot;We consider this incident to be an unprecedented cyber incident, involving state-of-the-art cyber capabilities, and are responding accordingly.&quot; — OpenAI" />
```

An actual excerpt, not a repeated title, not a publish date. One more thing worth noting: I almost shipped a second bug on top of the fix. `cmark` already HTML-escapes quotes and ampersands in rendered text (`"` becomes `&quot;` before my code ever sees it). I'd added my own escaping on top, for a real concern — a URL-derived fallback title, built from unescaped request path text, needed it — but I'd applied it everywhere, which meant anything pulled from already-rendered HTML got double-escaped into garbage like `&amp;quot;`. Caught it locally before it reached production, by actually rendering sample markdown through `cmark` and reading the output instead of assuming.

## The lesson, if there's one

Small nginx module, small change, and it still found a real way to take a site offline. Overwriting a live shared library and reloading instead of restarting isn't an edge case — it's the default way people deploy `.so` files, and it works fine right up until the timing doesn't. Test the actual bytes an external library produces before trusting your assumptions about what it already escaped. And when a production system is actively crash-looping, the first move is to stop it, not to keep debugging on top of it.

---
