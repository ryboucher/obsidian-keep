# Product

## Register

product

## Users

ADHD note-takers and Google Keep refugees using Obsidian. They want visual, colorful note organization without cognitive overload. Not primarily for quick capture (that happens elsewhere); the value is browsing, searching, and navigating an existing vault visually. Key workflows: scanning notes by color and card layout, searching with filters (folder, tag, color, type), and bookmarking frequently-accessed folders like "Brain Dump" and "Journal" for one-tap access.

## Product Purpose

A Google Keep-style card view inside Obsidian. Notes are regular .md files with frontmatter for color and pin state, keeping full vault compatibility. Success looks like: opening the plugin replaces the need to ever open Google Keep again. The card grid makes a large vault feel approachable instead of overwhelming.

**Non-negotiable qualities:** Quick access (cards visible within 200ms of opening), fast speed (search filters instantly, no loading spinners), rock-solid stability (never crashes, never loses data, never blocks the main Obsidian UI), and simple navigation (one tap to any folder, zero learning curve).

## Brand Personality

Calm, warm, capable. Confident without being loud. The interface should feel like a warm desk with organized sticky notes, not a productivity tool shouting at you. Quiet competence over flashy features.

## Anti-references

- **Notion**: Too many options, too much structure, decision paralysis on every interaction. Notes are not databases.
- **Trello / Kanban boards**: Columns imply workflow and stages. Notes are freeform, not pipeline items. No left-to-right progression.
- **Generic Obsidian plugins**: Developer-aesthetic, text-heavy, no visual warmth. Cards should feel like objects, not rendered markdown.

## Design Principles

1. **Instant and stable above all.** Cards render within 200ms. No spinners, no jank, no crashes. If it's not fast, nothing else matters. Performance is the first feature.
2. **Simple navigation, zero learning curve.** One tap to any folder. Folder bookmarks for frequent destinations. No menus within menus. If a user has to think about how to get somewhere, the navigation failed.
3. **Cards are objects, not containers.** A card should feel like a colored sticky note you can pick up, not a bordered div wrapping text. Visual weight comes from color and content density, not chrome.
4. **Search is navigation.** Finding a note should feel like walking to the right shelf, not querying a database. Color filtering, operator search, and folder bookmarks all serve spatial memory.
5. **Respect the vault.** Every note is a real .md file. No proprietary storage, no lock-in. Plugin adds a view layer; it never owns the data.
6. **Calm density.** Show many notes without overwhelming. Variable card heights (masonry) create visual rhythm. Consistent but not uniform.
7. **Mobile is primary.** Phone is where notes get browsed most. Touch targets, scroll performance, and 2-column grid on narrow screens are not afterthoughts.

## Accessibility & Inclusion

Basic keyboard navigation and screen reader support. WCAG AA contrast. Reduced motion support via `prefers-reduced-motion`. No special ADHD accommodations beyond what the calm-density principle already provides. Touch targets minimum 36px on mobile, 44px recommended for primary actions.
