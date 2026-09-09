# Terminal presentation design playbook

## Design for attention, not storage

A slide is a moment in an explanation. It is not a page of documentation. The audience should understand what to look at within one or two seconds.

Before authoring, write one sentence per planned slide:

> After this slide, the audience should understand that ...

If the sentence contains “and,” consider splitting the slide.

## Narrative patterns

### Teaching

1. Familiar situation.
2. Incorrect or incomplete mental model.
3. New model.
4. Worked example.
5. Limits and edge cases.
6. Practical takeaway.

### Technical proposal

1. Desired outcome.
2. Current constraint.
3. Evidence of the cost.
4. Proposed architecture.
5. Why it works.
6. Trade-offs and risks.
7. Migration or next step.

### Demo

1. What the audience will see.
2. Why it matters.
3. System map.
4. Small live path.
5. Result.
6. How it works.
7. Failure mode and fallback.
8. Takeaway.

### Project review

1. Goal and current state.
2. What changed.
3. Evidence and metrics.
4. What was learned.
5. Risks or blockers.
6. Decision needed.
7. Next milestone.

## Visual hierarchy

Every slide should have three levels at most:

1. title or dominant statement;
2. primary content;
3. muted context, label, or attribution.

Use size, whitespace, position, and weight before adding color. One accent color used consistently is stronger than six unrelated colors.

## Composition rhythm

Create rhythm by alternating density and composition:

- sparse hook;
- explanatory slide;
- visual or code slide;
- sparse statement;
- evidence or comparison;
- summary.

Do not alternate mechanically. The principle is to give the audience moments of focus and recovery.

## Terminal-specific constraints

- Monospace text makes line length and alignment visually dominant.
- Wide terminals can make prose hard to scan; cap the canvas around 90–110 columns.
- Terminal rows are scarce. Prefer horizontal relationships only when they remain legible.
- Unicode glyphs differ across fonts. Use common symbols and test unusual characters.
- Large font commands may be ignored by unsupported terminals. The hierarchy must still work at normal size.
- Images can degrade to ASCII. Never make an unlabeled image the only carrier of meaning.
- Tables become unreadable quickly. Use two to four columns and few rows.

## Copy rules

Good slide title:

> The cache removes the wrong bottleneck

Weak slide title:

> Caching

Good bullet:

> Retries multiply load during partial failure.

Weak bullet:

> We should also take into consideration the issue of retries and how they can potentially have an impact on the overall load of the system.

Prefer claims over categories, verbs over noun stacks, and concrete examples over abstraction.

## Code slides

A code slide should answer one question. Before adding code, state the question in the title:

- “Where does state enter the pipeline?”
- “Why can this request execute twice?”
- “The fix is one boundary, not three checks.”

Remove imports, framework ceremony, and unrelated branches from the visible snippet. Use external files or hidden executable lines so the displayed code remains truthful without becoming noisy.

Use dynamic highlighting when the same snippet supports several spoken beats. Avoid redrawing the whole slide for tiny code changes unless the change itself is the point.

## Diagrams

A useful diagram names a relationship the audience would otherwise have to hold in working memory.

Good diagram characteristics:

- three to seven nodes;
- one reading direction;
- short labels;
- clear system boundary;
- no decorative nodes;
- consistent arrow meaning.

For a complex architecture, reveal layers across multiple slides: request path, state path, failure path, then complete view.

## Motion and pauses

Motion should reveal causality, sequence, or change. It should not merely signal that the presenter pressed a key.

Use a pause for:

- question then answer;
- premise then consequence;
- before then after;
- progressive code explanation;
- staged diagram construction.

Avoid pauses inside information the audience must compare simultaneously.

Use one subtle transition style for the whole deck. Fast fades are generally less distracting than dramatic movement.

## Accessibility and robustness

- Maintain high foreground/background contrast.
- Do not use red/green alone to distinguish states; add labels or symbols.
- Avoid very dim body copy.
- Write meaningful titles that remain useful in the slide index.
- Keep commands and paths copyable in source form.
- Provide static fallbacks for live execution and optional renderers.

## Final edit passes

### Story pass

Read only the slide titles. They should form a coherent argument.

### Density pass

Find the three busiest slides and simplify them.

### Consistency pass

Check title capitalization, punctuation, code style, labels, colors, and footer behavior.

### Spoken pass

Present aloud. Rewrite any slide that forces you to read verbatim or explain where the audience should look.

### Failure pass

Test without images, without optional diagram tools, and without live execution. The core story should remain intact.
