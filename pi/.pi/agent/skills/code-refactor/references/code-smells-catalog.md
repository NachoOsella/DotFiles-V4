# Code Smells Catalog

Reference for identifying and remediating code smells. Consult this when you encounter a pattern that feels "off" but are unsure of the name or fix.

## Catalog

| Smell | Symptom | Refactoring |
|-------|---------|-------------|
| Long method | > 20 lines, multiple responsibilities | Extract method |
| Deep nesting | > 3 levels of indentation | Early returns, extract method |
| Duplicated code | Same logic in multiple places | Extract to shared function |
| Large class | Too many responsibilities | Split into focused classes |
| Primitive obsession | Raw types instead of domain objects | Create value objects |
| Feature envy | Method uses another class's data heavily | Move method |
| Shotgun surgery | One change requires edits in many classes | Move features, consolidate |
| Divergent change | One class changes for many reasons | Extract class |
| Parallel inheritance | Subclasses mirror each other | Collapse hierarchy, delegate |
| Speculative generality | Unused hooks or abstractions | Inline class, remove layers |
| Temporary field | Fields only used in some flows | Extract class, move fields |
| Message chains | `a.b.c.d()` | Hide delegate, extract method |
| Middle man | Class delegates everything | Remove middle man, inline |
| Data clumps | Same groups of variables passed together | Extract class, parameter object |
| Refused bequest | Subclass ignores parent behavior | Replace inheritance with delegation |
| Comments explaining code | Comments compensate for poor naming | Rename variables, extract method |
| Magic numbers | Hardcoded numeric literals | Replace with named constants |
| Long parameter list | > 4 parameters | Introduce parameter object |
| Switch statements | Repeated switch/case on type | Replace with polymorphism |
| Lazy class | Class does too little | Inline class, merge |
| Data class | Only fields and getters/setters | Encapsulate behavior into class |
| Indecent exposure | Internals exposed unnecessarily | Reduce visibility, encapsulate |
| Dead code | Unused methods, variables, imports | Delete |
| Alternative classes with different interfaces | Classes do same thing differently | Unify interface, adapter |
| Oddball solution | Different approach to same problem | Standardize solution |
| Greedy method | Method grabs data from many objects | Split, move closer to data |
| Hidden dependencies | Implicit coupling through globals/state | Inject dependencies explicitly |
| Boolean blindness | Booleans passed without context | Use enums, named parameters |
| Collection obsession | Arrays/lists manipulated everywhere | Encapsulate collection behavior |
| Null checks everywhere | Defensive null checking | Null object pattern, optionals |
| Side effects in getters | Getters mutate state | Remove side effects, rename method |
| Sequential coupling | Methods must be called in order | Combine, return intermediate object |
| Inconsistent naming | Mixed conventions across codebase | Standardize naming scheme |
| Type casting everywhere | Frequent downcasting | Use generics, visitor pattern |
| Feature toggles in code | Dead toggles mixed with live code | Remove toggles, branch by abstraction |

## Smell Severity

| Severity | Action |
|----------|--------|
| Critical (security, data loss risk) | Fix immediately |
| High (blocks comprehension) | Fix in current PR |
| Medium (local complexity) | Fix or ticket for next sprint |
| Low (cosmetic) | Address when touching nearby code |
