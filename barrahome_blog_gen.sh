#!/bin/bash
#
# barrahome_blog_gen.sh - generates index.md from blog posts
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

posts=()
all_tags=()

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

    # collect unique tags
    if [ -n "$tags" ]; then
        IFS=',' read -ra tag_arr <<< "$tags"
        for t in "${tag_arr[@]}"; do
            t=$(echo "$t" | xargs) # trim whitespace
            all_tags+=("$t")
        done
    fi

    # store as sortable entry (date|title|path|tags)
    posts+=("${date}|${title}|${relpath}|${tags}")
done < <(find "$BLOG_DIR" -path '*/[0-9][0-9][0-9][0-9]/[0-9][0-9]/[0-9][0-9]/*.md' -type f)

# sort by date descending
IFS=$'\n' sorted=($(printf '%s\n' "${posts[@]}" | sort -t'|' -k1 -r))
unset IFS

# get unique sorted tags
IFS=$'\n' unique_tags=($(printf '%s\n' "${all_tags[@]}" | sort -u))
unset IFS

# generate index.md
{
    # tag filter buttons
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

        # build tag codes
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

echo "index.md generated with ${#sorted[@]} posts and ${#unique_tags[@]} tags"
