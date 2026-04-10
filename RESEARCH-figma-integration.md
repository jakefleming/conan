# Figma Integration Research for Conan

**Date:** 2026-03-19

---

## The Core Problem

Figma has TWO APIs, and this is where most confusion starts:

| | Plugin API | REST API |
|--|-----------|----------|
| **Read design nodes** | ✅ | ✅ |
| **Write/create design nodes** | ✅ | ❌ |
| **Runs headlessly** | ❌ (needs desktop app open) | ✅ |
| **Variables (design tokens)** | ✅ | ✅ (full CRUD) |
| **Comments** | ❌ | ✅ |

**The fundamental constraint:** You cannot programmatically CREATE design elements through the REST API. Every write solution requires either the desktop app running, a WebSocket bridge, or a CDP hack.

---

## What Actually Exists (Ranked by Relevance to Conan)

### Tier 1: You Should Know About These

**figma-use** (507 ⭐) — https://github.com/dannote/figma-use
- 100+ CLI commands with full read/write access to Figma
- Connects via Chrome DevTools Protocol directly to Figma Desktop
- **Includes an MCP server** — so Claude Code can already use it
- No API key needed; uses your existing Figma session
- Supports JSX for declarative UI creation
- **This is the most comprehensive headless write tool that exists**

**TalkToFigma by Grab** (6,512 ⭐) — https://github.com/grab/cursor-talk-to-figma-mcp
- MCP integration for Cursor and Claude Code
- WebSocket bridge + Figma plugin for bidirectional communication
- Read AND write: create elements, adjust styling, replace text, export assets

**Figma's Official MCP Server** — `https://mcp.figma.com/mcp`
- 14+ tools as of Feb 2026
- `get_design_context` — reads structured layout data
- `generate_figma_design` (Claude Code exclusive) — captures live running UI from browser and converts to editable Figma layers
- **This is the officially blessed path for code → Figma**

**story.to.design** — https://story.to.design
- Imports Storybook stories directly into Figma as native components
- Framework-agnostic (React, Vue, Angular, Svelte)
- One-click sync when Storybook changes
- **Most production-ready code-to-Figma pipeline for design systems**

### Tier 2: Interesting but Niche

**react-figma** (2,677 ⭐) — https://github.com/react-figma/react-figma
- Write JSX → renders directly into Figma nodes
- Uses Yoga Layout for flexbox
- Runs as a Figma plugin

**html.to.design** — https://html.to.design
- Chrome extension that converts any live website into editable Figma designs
- Captures real DOM structure

**figma-to-json** — https://github.com/yagudaev/figma-to-json
- Read AND write .fig files as JSON without Figma
- The .fig format uses the Kiwi binary schema (created by Figma's former CTO)
- **Fragile** — undocumented, Figma can change it anytime

**Figma Code Connect** (official, 1,417 ⭐) — https://github.com/figma/code-connect
- Maps design components ↔ code implementations in Dev Mode
- Not a converter — more of a documentation bridge
- Supports React, Vue, Angular, SwiftUI, Compose

### Tier 3: The Nuclear Option

**Penpot** — https://penpot.app
- Fully open-source Figma alternative
- SVG-based (open standard, not proprietary binary)
- **RPC API supports full write access headlessly** — no desktop app needed
- Native W3C design tokens
- Free inspect/CSS export (no paid Dev Mode)
- MCP servers exist
- **If Figma's API limitations are truly blocking you, this solves them**

---

## The .fig File Format

Has been partially reverse-engineered:
- ZIP container with "PK" header
- Design data uses **Kiwi** binary schema (open-sourced by Evan Wallace)
- Compressed with DEFLATE or Zstandard
- Online parser: https://madebyevan.com/figma/fig-file-parser/
- Kiwi repo: https://github.com/evanw/kiwi

**Figma Make (.make) files** are a different format — they contain full React apps (Radix UI + Tailwind). Already reverse-engineered: https://github.com/albertsikkema/figma-make-extractor

---

## What This Means for Conan

### Option A: Use figma-use + MCP (Easiest, Most Powerful)

You already have MCP infrastructure. `figma-use` has an MCP server that provides full read/write access to Figma. The integration would be:

1. Install figma-use: `bun add figma-use`
2. Connect its MCP server to your workflow
3. Conan's chat gets new tools: `create_figma_frame`, `update_figma_node`, `read_figma_component`
4. Claude can: read your annotated sketch → create Figma elements via figma-use → you refine in Figma

**Requirement:** Figma Desktop must be open (CDP connection).

### Option B: Figma's Official MCP `generate_figma_design`

The official path:
1. Claude Code renders your component in a browser
2. Captures the live UI
3. Converts to editable Figma layers
4. Pushes to your Figma file

**This already works if you have the Figma MCP connected** (which you do — I can see it in your tool list). The `generate_figma_design` tool could theoretically take Conan's annotated sketch context → generate code → render → push to Figma.

### Option C: Conan as the Spec Layer (No Direct Figma Write)

Skip the API pain entirely:
1. Conan generates structured component specs from annotated sketches
2. Specs include: component tree, props, states, layout, colors, typography
3. Export as a rich HTML spec page with visual previews
4. Designer opens spec alongside Figma, builds manually but with perfect clarity
5. Use html.to.design to capture the spec preview INTO Figma as a starting point

### Option D: Penpot for Programmatic Stuff, Figma for Polish

Use Penpot's headless write API for AI-generated layouts, then export SVG → import into Figma for final polish. Best of both worlds but adds another tool.

---

## My Recommendation

**Start with Option B** — you already have Figma's MCP server connected. Test the `generate_figma_design` flow:

```
Annotated sketch in Conan → Claude generates React component →
Renders in browser → Figma MCP captures → Editable Figma layers
```

If that's too lossy or unreliable, **add figma-use (Option A)** for direct node manipulation. The MCP server means Conan's chat could have a `push_to_figma` tool that creates frames, text, and shapes based on the sketch annotations.

**Don't build your own Figma.** The ecosystem has enough bridges now that the problem is solvable with existing tools. The real value Conan adds is the **design intent layer** — the annotated sketches, the structured specs, the Claude analysis. That context is what makes the Figma generation better, regardless of which bridge you use.

---

## Key Links

- figma-use: https://github.com/dannote/figma-use
- TalkToFigma: https://github.com/grab/cursor-talk-to-figma-mcp
- Framelink MCP: https://github.com/GLips/Figma-Context-MCP
- story.to.design: https://story.to.design
- html.to.design: https://html.to.design
- react-figma: https://github.com/react-figma/react-figma
- Figma Code Connect: https://github.com/figma/code-connect
- figma-to-json: https://github.com/yagudaev/figma-to-json
- Penpot: https://penpot.app
- Penpot MCP: https://github.com/zcube/penpot-mcp-server
- Figma MCP Guide: https://help.figma.com/hc/en-us/articles/32132100833559
