#!/bin/bash
#
# barrahome_blog_gen.sh - generates index.md, tags.js, sitemap.xml and llm.txt
#
# Scans for .md files matching YYYY/MM/DD/*.md, extracts the title
# and tags from each post, and generates the post list sorted by
# date (newest first) with a tag filter section.
#
# Post format expected:
#   # Title
#   **YYYY/MM/DD**
#   **Tags:** tag1, tag2, tag3
#

BLOG_DIR="$(cd "$(dirname "$0")" && pwd)"
INDEX="$BLOG_DIR/index.md"
SITEMAP="$BLOG_DIR/sitemap.xml"
LLM_FILE="$BLOG_DIR/llm.txt"
DOMAIN="https://barrahome.org"

posts=()
all_tags=()

# get lastmod date from git or fallback to file mtime
get_lastmod() {
    local file="$1"
    local gitdate=$(git log -1 --format="%ad" --date=short -- "$file" 2>/dev/null)
    if [ -n "$gitdate" ]; then
        echo "$gitdate"
    else
        date -r "$file" +%Y-%m-%d
    fi
}

while IFS= read -r file; do
    # extract date from path: YYYY/MM/DD
    date=$(echo "$file" | grep -oP '\d{4}/\d{2}/\d{2}')
    [ -z "$date" ] && continue

    # extract title from first h1
    title=$(grep -m1 '^# ' "$file" | sed 's/^# //')
    [ -z "$title" ] && title="Untitled"

    # extract tags from **Tags:** line
    tags=$(grep -m1 '^\*\*Tags:\*\*' "$file" | sed 's/^\*\*Tags:\*\* *//')

    # relative path from blog root
    relpath="${file#"$BLOG_DIR"/}"

    # get lastmod for sitemap
    lastmod=$(get_lastmod "$file")

    # collect unique tags
    if [ -n "$tags" ]; then
        IFS=',' read -ra tag_arr <<< "$tags"
        for t in "${tag_arr[@]}"; do
            t=$(echo "$t" | xargs) # trim whitespace
            all_tags+=("$t")
        done
    fi

    # store as sortable entry (date|title|path|tags|lastmod)
    posts+=("${date}|${title}|${relpath}|${tags}|${lastmod}")
done < <(find "$BLOG_DIR" -path '*/[0-9][0-9][0-9][0-9]/[0-9][0-9]/[0-9][0-9]/*.md' -type f)

# sort by date descending
IFS=$'\n' sorted=($(printf '%s\n' "${posts[@]}" | sort -t'|' -k1 -r))
unset IFS

# get unique sorted tags
IFS=$'\n' unique_tags=($(printf '%s\n' "${all_tags[@]}" | sort -u))
unset IFS

# ====================
# Generate index.md
# ====================
{
    echo "**Filter:** \`all\` $(printf '`%s` ' "${unique_tags[@]}")"
    echo ""
    echo "---"
    echo ""
    echo "## Posts"
    echo ""
    for entry in "${sorted[@]}"; do
        date=$(echo "$entry" | cut -d'|' -f1)
        title=$(echo "$entry" | cut -d'|' -f2)
        path=$(echo "$entry" | cut -d'|' -f3)
        tags=$(echo "$entry" | cut -d'|' -f4)

        tag_codes=""
        if [ -n "$tags" ]; then
            IFS=',' read -ra tag_arr <<< "$tags"
            for t in "${tag_arr[@]}"; do
                t=$(echo "$t" | xargs)
                tag_codes="$tag_codes \`$t\`"
            done
        fi

        echo "- **${date}** - [${title}](/${path})${tag_codes}"
    done
} > "$INDEX"

# ====================
# Generate tags.js
# ====================
{
    echo "var defined_tags = ["
    for i in "${!unique_tags[@]}"; do
        if [ "$i" -lt $(( ${#unique_tags[@]} - 1 )) ]; then
            echo "    \"${unique_tags[$i]}\","
        else
            echo "    \"${unique_tags[$i]}\""
        fi
    done
    echo "];"
} > "$BLOG_DIR/js/tags.js"

# ====================
# Generate sitemap.xml
# ====================
cat > "$SITEMAP" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <!-- Home -->
  <url>
    <loc>https://barrahome.org/</loc>
EOF

echo "    <lastmod>$(date +%Y-%m-%d)</lastmod>" >> "$SITEMAP"

cat >> "$SITEMAP" << 'EOF'
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>

  <!-- Static Pages -->
EOF

for page in projects.md cv.md contact.md; do
    if [ -f "$BLOG_DIR/$page" ]; then
        lastmod=$(get_lastmod "$BLOG_DIR/$page")
        cat >> "$SITEMAP" << EOF
  <url>
    <loc>$DOMAIN/$page</loc>
    <lastmod>$lastmod</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
EOF
    fi
done

echo "" >> "$SITEMAP"
echo "  <!-- Blog Posts -->" >> "$SITEMAP"

for entry in "${sorted[@]}"; do
    path=$(echo "$entry" | cut -d'|' -f3)
    lastmod=$(echo "$entry" | cut -d'|' -f5)

    cat >> "$SITEMAP" << EOF
  <url>
    <loc>$DOMAIN/$path</loc>
    <lastmod>$lastmod</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>
EOF
done

echo "</urlset>" >> "$SITEMAP"

# ====================
# Generate llm.txt
# ====================
cat > "$LLM_FILE" << 'EOF'
# barrahome.org - LLM Context File

## Site Overview
Personal blog and technical documentation by Alberto Ferrer.
Focus: nginx, Linux system administration, performance optimization, distributed systems, and modern web architecture.

## Author
- Name: Alberto Ferrer
- Site: https://barrahome.org
- GitHub: https://github.com/bet0x
- LinkedIn: https://www.linkedin.com/in/bet0x/

## Technology Stack
- Hosting: nginx with custom ngx_markdown_filter_module
- Content: Markdown files (.md) converted to HTML on-the-fly
- No static site generator - real-time markdown rendering
- Client-side tag filtering with vanilla JavaScript
- Styling: Custom CSS with terminal/window aesthetic

## Content Structure

### Main Pages
- Home: https://barrahome.org/
- Projects: https://barrahome.org/projects.md
- CV/Resume: https://barrahome.org/cv.md
- Contact: https://barrahome.org/contact.md

### Blog Posts (Latest First)
EOF

for entry in "${sorted[@]}"; do
    date=$(echo "$entry" | cut -d'|' -f1)
    title=$(echo "$entry" | cut -d'|' -f2)
    path=$(echo "$entry" | cut -d'|' -f3)

    echo "- $date: $title" >> "$LLM_FILE"
    echo "  $DOMAIN/$path" >> "$LLM_FILE"
    echo "" >> "$LLM_FILE"
done

cat >> "$LLM_FILE" << 'EOF'
## Topics & Tags
EOF

for tag in "${unique_tags[@]}"; do
    echo "- $tag" >> "$LLM_FILE"
done

cat >> "$LLM_FILE" << 'EOF'

## Notable Features
- Custom nginx markdown filter module (author contribution)
- Real-time markdown to HTML conversion
- Tag-based post filtering
- Terminal-inspired UI design
- Mermaid diagram support
- Open source blog engine

## Source Code
GitHub Repository: https://github.com/bet0x/barrahome-2026

## Content Philosophy
Technical depth over breadth. Practical tutorials with real-world examples.
Focus on performance, optimization, and understanding how things work under the hood.

## Update Frequency
Active blog with regular posts on nginx, performance optimization, and distributed systems.

---
EOF

echo "Last updated: $(date +%Y-%m-%d)" >> "$LLM_FILE"

# ====================
# Generate robots.txt
# ====================
cat > "$BLOG_DIR/robots.txt" << 'EOF'
# robots.txt for barrahome.org
# Personal blog and technical documentation

User-agent: *
Allow: /

# Block unwanted bots
User-agent: GPTBot
User-agent: ChatGPT-User
User-agent: Google-Extended
User-agent: CCBot
User-agent: anthropic-ai
User-agent: Claude-Web
Allow: /

# Aggressive crawlers
User-agent: Bytespider
User-agent: Amazonbot
Disallow: /

# Sitemap
Sitemap: https://barrahome.org/sitemap.xml

# LLM context file
# See: https://barrahome.org/llm.txt
EOF

# ====================
# Summary
# ====================
echo "✓ index.md generated with ${#sorted[@]} posts and ${#unique_tags[@]} tags"
echo "✓ js/tags.js generated with ${#unique_tags[@]} tags"
echo "✓ sitemap.xml generated with $(( ${#sorted[@]} + 4 )) URLs"
echo "✓ llm.txt generated with ${#sorted[@]} posts and ${#unique_tags[@]} tags"
echo "✓ robots.txt generated"
