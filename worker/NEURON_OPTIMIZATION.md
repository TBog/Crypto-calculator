# Text Extraction Optimization for Neuron Budget

## Overview
This document describes the optimization made to reduce Cloudflare Workers AI neuron usage when processing news articles.

## Problem
Previously, when extracting content from news article webpages, the system was extracting ALL text content from the HTML, including:
- Headers and navigation menus
- Footers and copyright notices
- Sidebars and related article links
- Advertisements and promotional content
- Social media sharing buttons
- Comment sections

This resulted in sending unnecessary content to the AI for summarization, wasting Cloudflare's neuron budget (limited to 10,000 neurons per day on the Free Tier).

## Solution
The `TextExtractor` class in `news-processor-cron.js` has been optimized to skip non-content elements:

### Elements Skipped by Tag Name
- `<nav>` - Navigation menus
- `<header>` - Page headers
- `<footer>` - Page footers
- `<aside>` - Sidebars
- `<menu>` - Menu elements
- `<form>`, `<button>`, `<input>`, `<select>`, `<textarea>` - Form elements
- `<iframe>`, `<noscript>`, `<svg>`, `<canvas>` - Non-text elements

### Elements Skipped by Class/ID Patterns
Elements with class names or IDs containing these patterns are skipped:
- `nav`, `menu` - Navigation elements
- `header`, `footer` - Header/footer sections
- `sidebar`, `aside` - Sidebar content
- `advertisement`, `ad-`, `promo`, `banner` - Advertisements
- `widget` - Widgets and plugins
- `share`, `social` - Social media buttons
- `comment` - Comment sections
- `related`, `recommend` - Related content suggestions

## Implementation Details

### Skip Depth Tracking
The implementation uses a `skipDepth` counter to handle nested elements:
- When entering a skipped element, `skipDepth` is incremented
- When leaving a skipped element (via `onEndTag`), `skipDepth` is decremented
- Text is only extracted when `skipDepth === 0`

This ensures that text within nested skipped elements is properly ignored.

### Performance Optimizations
To minimize CPU overhead and stay within Worker execution time limits:
- **Set-based lookups**: SKIP_TAGS uses a Set for O(1) tag lookups instead of array iteration
- **Early returns**: Tag check happens first with early return to skip pattern matching
- **Conditional pattern checks**: Pattern matching only runs when `skipDepth === 0`, avoiding redundant checks on already-skipped content
- **Combined string checks**: className and id are combined into one string for a single toLowerCase() call
- **Minimal onEndTag usage**: While onEndTag has memory overhead, it's necessary for correct nested element handling. We minimize registrations by early returns and conditional checks.

### Example
```html
<article>
  <header>Site Header - Skip This</header>
  <p>This is the article content that should be extracted.</p>
  <aside class="sidebar">
    <h3>Related Articles - Skip This</h3>
    <p>More content to skip</p>
  </aside>
  <p>More article content to extract.</p>
</article>
```

With the optimization:
- ✅ Extracts: "This is the article content that should be extracted. More article content to extract."
- ❌ Skips: "Site Header - Skip This", "Related Articles - Skip This", "More content to skip"

## Expected Impact
By extracting only main article content and skipping navigation, headers, footers, and ads:
- **Reduced content size**: Typically 50-70% reduction in text sent to AI
- **Lower neuron usage**: Directly proportional to content size reduction
- **More processing capacity**: Can process more articles within the daily 10,000 neuron limit
- **Better summaries**: AI focuses on actual article content, not site navigation

## Testing
The implementation logic was validated to ensure:
- ✅ Normal content is extracted correctly
- ✅ Navigation elements are skipped
- ✅ Header elements are skipped
- ✅ Elements with ad-related classes are skipped
- ✅ Nested skipped elements are handled correctly
- ✅ Multiple text chunks are properly concatenated

## Files Modified
- `worker/news-processor-cron.js`: Updated `TextExtractor` class with skip logic
