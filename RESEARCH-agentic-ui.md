# Agentic UI for Conan: Research & Recommendations

**Date:** 2026-03-19
**Source:** [Markdown as a Protocol for Agentic UI](https://fabian-kuebler.com/posts/markdown-agentic-ui/) by Fabian Kübler
**Context:** Evaluating how agentic UI patterns could enhance Conan's chat experience

---

## 1. What the Article Proposes

Fabian Kübler built a prototype called **Fenced** where an LLM generates not just text, but executable code and reactive UI components inline in a chat conversation. The key insight:

> "The system doesn't teach the model anything new. It arranges patterns the model already knows into a system that actually runs."

### The Three Core Ideas

**A. Markdown as a unified protocol**
The LLM's response stream carries three block types in standard markdown:
- **Text blocks** — regular markdown rendered as chat
- **Code fences** (`tsx agent.run`) — TypeScript that executes server-side
- **Data fences** (`json agent.data => "id"`) — JSON streamed directly into mounted UI components

The genius: LLMs already know markdown and code fences from training data. No fine-tuning needed.

**B. Streaming execution**
Code executes **statement by statement** as tokens arrive, not after the full block is complete. This means:
- API calls fire immediately, don't wait for the LLM to finish generating
- UI appears progressively (skeleton → content)
- Errors surface in real-time and feed back to the LLM for self-correction

He built a custom tool (`bun-streaming-exec`) using `vm.Script` to parse and execute individual statements as they stream in. He calls it "cursed" but it works.

**C. The `mount()` primitive**
A single function that serializes a React component definition, sends it over WebSocket, and renders it in the chat interface. The component has four data flow channels:

| Pattern | Direction | Mechanism | Example |
|---------|-----------|-----------|---------|
| Forms | Client → Server | Zod schema + `await form.result` | User fills in search filters, execution pauses until submit |
| Live updates | Server → Client | Proxy-based reactive objects, auto-patches via WebSocket | Progress bar updates as files are processed |
| Streaming data | LLM → Client | `jsonriver` incremental JSON parser | Table rows appear one by one as LLM generates them |
| Callbacks | Client → Server | Direct function references | Button click triggers server-side action without new LLM turn |

### The Slots Mechanism
For complex UIs, the LLM can mount a skeleton shell first, then progressively fill named "slots" as it generates more code. This means the user sees structure immediately while heavier sections load in.

```
LLM generates shell (instant) → User sees skeleton
LLM generates slot A (2s) → Chart fills in
LLM generates slot B (3s) → Table fills in
```

All slots share reactive state with the parent, so updating one value can affect multiple slots simultaneously.

---

## 2. Where Conan Already Aligns

Conan is **closer to this vision than it might seem**. We already have:

| Fenced Concept | Conan Equivalent | Gap |
|---------------|-----------------|-----|
| LLM generates structured output | `show_files` tool returns `{files, description}` | Works, but only one component type |
| Frontend renders dynamic components | `renderFilesetCard()` builds HTML from tool output | Hardcoded to file cards only |
| Bidirectional data flow | Chat attachments (user → server), search results (server → user) | No reactive updates, no callbacks |
| Multi-turn tool loop | 6-round tool-use loop with `search_index` + `show_files` | Already working well |
| Markdown rendering | `marked.js` parses Claude's response | Full markdown support |
| Reference links | `[[file:NAME]]` → clickable navigation | Already interactive |

**Key difference:** Fenced uses **code execution** (the LLM writes arbitrary React code). Conan uses **structured tools** (the LLM calls predefined tools with JSON arguments). Both approaches let the LLM create interactive UI, but tools are safer, simpler, and more predictable.

---

## 3. Recommendations for Conan

### Approach: Expand the Tool Component System

Rather than adopting Fenced's full code-execution model (which requires sandboxing, `vm.Script` hacking, and significant security work), **add more tool types that render as rich components**. This gives us 80% of the benefit with 10% of the complexity.

The LLM already knows how to call tools with structured arguments. We just need more component types on the frontend to render them.

---

### 3.1 New Tool Components (Priority Order)

#### A. `show_table` — Interactive Data Tables
**Why:** Claude frequently wants to present structured comparisons, search results, or extracted data. Right now it uses markdown tables which are static and hard to scan.

**Tool definition:**
```json
{
  "name": "show_table",
  "description": "Render an interactive data table with sortable columns",
  "input_schema": {
    "columns": ["Name", "Date", "Status", "Source"],
    "rows": [
      ["IRS Audit Widget", "2026-03-15", "Decided", "IMG_5213.jpeg"],
      ["Sleep Module", "2026-03-15", "In Progress", "IMG_5218.jpeg"]
    ],
    "title": "Decisions from off-site meetings",
    "sortable": true
  }
}
```

**Frontend renders:**
- Styled table with sticky headers
- Click column headers to sort
- Source column cells are clickable → navigate to file
- Row hover highlighting
- Optional: filter/search bar above table

**Effort:** Low. We already render spreadsheet tables — reuse that CSS.

#### B. `show_checklist` — Actionable Task Lists
**Why:** Claude extracts action items constantly ("Vic — design initial mockups"). These should be interactive, not just text.

**Tool definition:**
```json
{
  "name": "show_checklist",
  "description": "Render an interactive checklist that can be saved to annotations",
  "input_schema": {
    "title": "Action Items from IRS Meeting",
    "items": [
      {"text": "Design initial mockups for audit risk widget", "assignee": "Vic", "source": "IMG_5213.jpeg"},
      {"text": "Determine what data points to surface vs. withhold", "assignee": "Core team", "source": "IMG_5213.jpeg"}
    ]
  }
}
```

**Frontend renders:**
- Checkbox list with assignee badges
- Clicking a checkbox could write the completion status back to the source file's annotations (via a new API endpoint)
- Source file link for each item
- "Save to project" button that persists the checklist as a `.checklist.json` file

**Effort:** Medium. Needs a write-back mechanism.

#### C. `show_timeline` — Visual Timeline
**Why:** For meeting-heavy projects like yours, seeing chronology matters. "Show me everything from this month" is better as a timeline than a list.

**Tool definition:**
```json
{
  "name": "show_timeline",
  "description": "Render a visual timeline of events",
  "input_schema": {
    "events": [
      {"date": "2026-03-13", "title": "Off-site Day 1", "description": "Health modules, roadmap feature", "files": ["IMG_5210.jpeg", "IMG_5211.jpeg"]},
      {"date": "2026-03-15", "title": "IRS Meeting", "description": "Audit risk widget decisions", "files": ["IRS Audit Risk Visualization Strategy.txt"]}
    ]
  }
}
```

**Frontend renders:**
- Horizontal or vertical timeline with date markers
- Each node expands to show description + linked files
- File links navigate to the file in Conan

**Effort:** Medium. Pure frontend component, no backend changes.

#### D. `show_chart` — Simple Data Visualization
**Why:** "How annotated is my project?" or "What topics come up most?" are better answered visually.

**Tool definition:**
```json
{
  "name": "show_chart",
  "description": "Render a simple chart (bar, pie, or line)",
  "input_schema": {
    "type": "bar",
    "title": "Annotation Coverage",
    "labels": ["Annotated", "Unannotated", "In Progress"],
    "values": [12, 5, 3],
    "colors": ["#4ade80", "#6b7280", "#facc15"]
  }
}
```

**Frontend renders:**
- Pure CSS/SVG charts (no Chart.js dependency needed)
- Bar charts, pie/donut charts, simple line charts
- Tooltips on hover with values

**Effort:** Medium. SVG generation is straightforward but takes design polish.

#### E. `show_form` — Structured Input Collection
**Why:** Instead of Claude asking "what date range?" as text and parsing your natural language response, it could show a form with actual date pickers, dropdowns, and text fields.

**Tool definition:**
```json
{
  "name": "show_form",
  "description": "Collect structured input from the user",
  "input_schema": {
    "title": "Search Filters",
    "fields": [
      {"name": "topic", "type": "text", "label": "Topic", "placeholder": "e.g. nutrition"},
      {"name": "person", "type": "text", "label": "Person mentioned"},
      {"name": "date_from", "type": "date", "label": "From date"},
      {"name": "date_to", "type": "date", "label": "To date"}
    ]
  }
}
```

**Frontend renders:**
- Inline form within the chat
- Submit button sends the form data as the next user message (structured)
- Claude receives it and can use it for a targeted search

**Effort:** High. Requires a new message type where user input comes from a form rather than the text box. Also needs the multi-turn loop to handle form responses.

---

### 3.2 Progressive Rendering (Inspired by Slots)

**Current problem:** The user sees nothing until Claude's entire multi-turn loop completes (search → search → answer). This can take 10-15 seconds of blank chat.

**Proposed solution: Streaming status updates**

Instead of Fenced's full slot mechanism, add lightweight status events via Server-Sent Events (SSE) or chunked response:

```
[searching] Searching for "IRS meeting"...
[searching] Found 3 results, refining...
[rendering] Building response...
[complete] {reply: "...", fileset: {...}, table: {...}}
```

The frontend shows a live status indicator while Claude works:
```
🔍 Searching your files...          (replaces the empty space)
🔍 Found 3 results, analyzing...    (updates in place)
📝 Writing response...              (final stage)
→ Full response appears
```

**Implementation:** Change `/api/chat` from a single JSON response to an SSE stream. Each tool execution sends a status event. The final event contains the full response.

**Effort:** Medium-high. Requires refactoring the chat endpoint from request/response to streaming, and updating the frontend to handle SSE.

**Impact:** Massive UX improvement. The biggest complaint right now is the long wait with no feedback.

---

### 3.3 Callback Actions (Inspired by Client → Server Pattern)

**Current limitation:** Once Claude renders a response, it's static. You can click file references to navigate, but you can't interact with the response itself.

**Proposed: Action buttons in responses**

Claude could include actionable buttons in its response:

```markdown
Based on the IRS meeting notes, here are the action items:
1. Vic — Design initial mockups for audit risk widget
2. Core team — Determine what data points to surface

[Save as checklist] [Assign in Linear] [Export to PDF]
```

Each button triggers a server endpoint without starting a new chat turn:
- **Save as checklist** → writes a `.checklist.json` to the project
- **Export to PDF** → calls `/api/export` with the formatted content
- **Assign in Linear** → future integration point

**Implementation:** Add a `show_actions` tool or embed action buttons in existing components. Frontend sends a POST to a callback endpoint, shows a toast confirmation.

**Effort:** Low for basic actions, high for external integrations.

---

### 3.4 What NOT to Adopt from Fenced

| Fenced Feature | Why Skip It |
|---------------|-------------|
| **Arbitrary code execution** | Massive security surface. Conan is a local tool but still — `vm.Script` hacking is fragile. Structured tools give us the same result safely. |
| **React component generation** | Would require bundling React, adding a build step, and fundamentally changing the frontend architecture. Not worth it for the incremental benefit over HTML template rendering. |
| **Streaming code execution** | The `bun-streaming-exec` approach is clever but brittle. Our multi-turn tool loop achieves the same "LLM acts, gets feedback, continues" pattern without parsing partial TypeScript. |
| **WebSocket reactive state** | Overkill for our use case. Our components are rendered once per response. If we need live updates, SSE is simpler. |
| **Proxy-based data objects** | Adds complexity for a feature (server-push UI updates) we don't need yet. |

---

## 4. Suggested Implementation Phases

### Phase 1: Show Table + Show Checklist (1 session)
- Add `show_table` and `show_checklist` tool definitions to chat endpoint
- Build `renderTableCard()` and `renderChecklistCard()` in a new `public/js/components.js`
- Update `renderChatMessages()` to handle new component types
- Test with real queries against your research project

### Phase 2: Streaming Status (1 session)
- Refactor `/api/chat` to use Server-Sent Events
- Frontend shows live search/thinking status
- Final event delivers the full response + components
- Eliminates the "dead air" problem

### Phase 3: Show Timeline + Show Chart (1 session)
- Add timeline and chart components
- Pure frontend work — SVG rendering
- Good for "show me a timeline of all meetings" type queries

### Phase 4: Action Buttons + Write-back (1 session)
- Checklist items can be checked off and saved
- "Save to project" buttons on tables and checklists
- "Export" buttons for PDF/clipboard
- Toast confirmations for all actions

### Phase 5: Show Form (future)
- Structured input collection
- Most complex — requires new message flow
- Defer until the other components prove their value

---

## 5. Architecture Comparison

```
FENCED (Full Code Execution)              CONAN (Expanded Tool Components)
─────────────────────────────              ──────────────────────────────────
LLM writes React code                     LLM calls tools with JSON args
     ↓                                         ↓
vm.Script executes it                     Server validates + executes
     ↓                                         ↓
WebSocket streams component               JSON response with component data
     ↓                                         ↓
React renders in browser                  Template rendering in chat
     ↓                                         ↓
Proxy-based live reactivity               Static render + action callbacks

Pros: Maximum flexibility              Pros: Simple, safe, predictable
Cons: Security, complexity,            Cons: Limited to predefined
      fragile execution                      component types
```

**The Conan approach trades flexibility for reliability.** We can't render arbitrary UIs, but we can render a curated set of high-value components that cover 90% of what Claude would want to show. And we can add new component types incrementally as needs emerge.

---

## 6. Key Takeaway

The most valuable idea from Fenced isn't the code execution — it's the **mental model shift**: Claude's responses should be interactive artifacts, not just text. We're already partway there with smart file cards. The path forward is more component types, streaming feedback, and action buttons — all achievable within our current architecture.
