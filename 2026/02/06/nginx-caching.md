# nginx caching: proxy_cache and fastcgi_cache explained

**2026/02/06**

**Tags:** nginx, caching, linux, tutorial, debian

nginx's caching features are powerful but often underused. When configured correctly, they can turn a busy server into a quiet one, reducing load on backends and speeding up responses for users.

This post covers the two main caching systems in nginx: `proxy_cache` (for reverse‑proxy setups) and `fastcgi_cache` (for PHP‑FPM and similar). We'll also look at caching static files with `open_file_cache` and touch on cache purging.

## When to use caching

- **Static assets** (CSS, JS, images) – serve from memory, not disk
- **Dynamic pages that change infrequently** – blog posts, product listings
- **API responses** – cache GET requests that don't change every second
- **Heavy database queries** – cache the rendered HTML output

Caching works best when the **time‑to‑live (TTL)** is predictable. If a page updates every minute, cache it for 59 seconds. If it updates weekly, cache it for a week.

## proxy_cache: caching backend responses

Use `proxy_cache` when nginx acts as a reverse proxy for another HTTP server (Apache, another nginx, a Go service, etc.).

Basic configuration in an `http` block:

```nginx
# Define a cache zone
proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=mycache:10m 
                 max_size=1g inactive=60m use_temp_path=off;

# Enable caching for a location
location / {
    proxy_pass http://backend;
    proxy_cache mycache;
    proxy_cache_key "$scheme$request_method$host$request_uri";
    proxy_cache_valid 200 302 10m;
    proxy_cache_valid 404 1m;
    add_header X-Cache-Status $upstream_cache_status;
}
```

Key directives:

- `proxy_cache_path`: where to store cached files on disk, memory zone size, purge policy
- `proxy_cache_key`: how to identify unique cache entries (default includes `$scheme$proxy_host$request_uri`)
- `proxy_cache_valid`: how long to keep responses with different HTTP codes
- `$upstream_cache_status`: variable you can expose in headers to debug cache hits/misses

### Cache‑by‑pass and revalidation

Sometimes you need to skip the cache (e.g., during development or for logged‑in users):

```nginx
# Bypass cache if certain cookie is present
proxy_cache_bypass $cookie_nocache;
proxy_no_cache $cookie_nocache;

# Or by request header
proxy_cache_bypass $http_cache_control;
```

For conditional requests (If‑Modified‑Since, If‑None‑Match), nginx can revalidate cached items with the backend using `proxy_cache_revalidate on;`.

## fastcgi_cache: caching PHP‑FPM output

If you serve PHP via PHP‑FPM, `fastcgi_cache` works almost identically to `proxy_cache` but sits between nginx and the FastCGI process.

```nginx
fastcgi_cache_path /var/cache/nginx/fastcgi levels=1:2 
                   keys_zone=phpcache:10m max_size=1g inactive=60m;

server {
    location ~ \.php$ {
        include fastcgi_params;
        fastcgi_pass unix:/run/php/php8.2-fpm.sock;
        
        fastcgi_cache phpcache;
        fastcgi_cache_key "$scheme$request_method$host$request_uri";
        fastcgi_cache_valid 200 60m;
        fastcgi_cache_valid 404 10m;
        
        # Skip cache for POST requests and admin area
        fastcgi_cache_bypass $request_method = POST;
        fastcgi_no_cache $cookie_wordpress_logged_in;
    }
}
```

Common pitfalls:

- **Session‑dependent content**: exclude cookies that indicate a logged‑in user
- **POST requests**: never cache them (use `fastcgi_cache_bypass $request_method = POST`)
- **Vary headers**: nginx ignores `Vary` by default; if your backend sends `Vary: User‑Agent`, you may need to include `$http_user_agent` in the cache key

## Caching static files in memory

Even for static files served directly from disk, you can reduce I/O overhead with `open_file_cache`:

```nginx
http {
    open_file_cache max=1000 inactive=20s;
    open_file_cache_valid 30s;
    open_file_cache_min_uses 2;
    open_file_cache_errors off;
}
```

This keeps metadata (file descriptors, sizes, modification times) for up to 1000 files in memory, avoiding `stat()` calls on every request.

## Purging the cache

nginx doesn't have a built‑in purge mechanism, but you can delete cache files manually or use the `ngx_cache_purge` module.

Manual purge (on Debian):

```bash
# Find cache directory
grep proxy_cache_path /etc/nginx/nginx.conf

# Delete everything (be careful)
rm -rf /var/cache/nginx/*

# Or delete specific key
# (requires calculating the MD5 of the cache key)
```

A more elegant approach is to use the `ngx_cache_purge` module (available as a dynamic module for Debian's nginx). Once loaded, you can send a `PURGE` request to invalidate a URL:

```nginx
location ~ /purge(/.*) {
    allow 127.0.0.1;
    deny all;
    proxy_cache_purge mycache "$scheme$request_method$host$1";
}
```

## Monitoring cache performance

Check the `$upstream_cache_status` variable to see hits/misses:

```nginx
add_header X-Cache-Status $upstream_cache_status;
```

Then look at the header in browser dev tools or logs:

- `HIT` – served from cache
- `MISS` – fetched from backend, stored in cache
- `BYPASS` – cache was skipped
- `EXPIRED` – cached entry expired, revalidated
- `STALE` – served stale content while revalidating
- `UPDATING` – cache is being updated

Log it permanently:

```nginx
log_format cache_log '$remote_addr - $upstream_cache_status [$time_local] "$request"';
access_log /var/log/nginx/cache.log cache_log;
```

## Real‑world example: caching a WordPress site

For a typical WordPress blog, you might combine several techniques:

```nginx
# http block
proxy_cache_path /var/cache/nginx/proxy levels=1:2 keys_zone=wp_proxy:10m max_size=1g;
fastcgi_cache_path /var/cache/nginx/fastcgi levels=1:2 keys_zone=wp_php:10m max_size=1g;

# server block
server {
    # Static assets – open_file_cache
    location ~* \.(jpg|jpeg|png|gif|ico|css|js)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        open_file_cache max=1000 inactive=20s;
    }

    # PHP requests – fastcgi_cache
    location ~ \.php$ {
        fastcgi_pass unix:/run/php/php8.2-fpm.sock;
        fastcgi_cache wp_php;
        fastcgi_cache_key "$scheme$request_method$host$request_uri";
        fastcgi_cache_valid 200 302 10m;
        fastcgi_cache_valid 404 1m;
        
        # Don't cache logged‑in users
        fastcgi_cache_bypass $cookie_wordpress_logged_in;
        fastcgi_no_cache $cookie_wordpress_logged_in;
        
        add_header X-FastCGI-Cache $upstream_cache_status;
    }

    # Admin area – no cache
    location ~* /wp-admin/ {
        fastcgi_pass unix:/run/php/php8.2-fpm.sock;
        fastcgi_cache_bypass 1;
        fastcgi_no_cache 1;
    }
}
```

## Final thoughts

Caching is a trade‑off between freshness and performance. Start with a short TTL (minutes) and increase as you gain confidence. Always monitor `$upstream_cache_status` to verify the cache is working.

On Debian, remember that nginx packages are built without the cache‑purge module by default. If you need it, you'll have to compile nginx with `--add‑module` or install the dynamic module from a third‑party repository.

When in doubt, cache less rather than more. A stale page is worse than a slow one.

---

*Next time: tuning nginx for high concurrency with `worker_processes`, `worker_connections`, and `keepalive`.*