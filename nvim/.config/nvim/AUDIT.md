# Neovim resource audit

## Scope and method

Reviewed all Neovim configuration files, extras, plugin specs, custom Lua, the starter README, ignored lockfile, installed LazyVim/plugin implementations, Mason receipts, and related dotfiles references. Four parallel audits covered LSPs, lint/format, plugins/completion/Treesitter, and runtime/custom code. No project dependencies or unrelated dotfiles were changed.

Installed versions were Neovim 0.12.5, LazyVim 16.0.1 at `999700997f72227187d49d8b92667183dc7fc809`, vtsls 0.3.0, and Angular Language Server 21.2.12. TypeScript selection comes from LazyVim's `extras/lang/typescript/init.lua`, not from the manually installed `typescript-language-server` package.

Measurements used the same existing Angular application with installed dependencies, Angular 17.3.12 and TypeScript 5.3.3. Neovim ran with a UI in a pseudo-terminal and an RPC socket. Each run opened the same root component, waited 30 seconds, collected clients/plugins/formatters/linters/processes, entered and left Insert mode, and sampled again after 15 seconds. Feature tests and health checks ran after the memory samples. No project files were saved.

RSS came from `ps -eo pid,ppid,rss,args --sort=-rss`. The totals below include only each measured Neovim process and its descendants, not unrelated browser processes or concurrent audit sessions. RSS sums can double-count shared pages; these are not PSS or peak memory measurements. The new Neovim UI uses a frontend and an embedded editor process, both counted below.

Full local artifacts, including Lazy profile data, health output, LSP capabilities, request results, startup logs and process snapshots, are in `/tmp/nvim-audit/`. These temporary artifacts are not committed and will not survive cleanup of `/tmp`.

## Before and after

Same Angular project, 30 seconds after opening the component, before Copilot starts. Units are MiB.

| Measurement | Before | After |
| --- | ---: | ---: |
| Neovim editor RSS | 51.5 | 47.3 |
| Neovim UI frontend RSS | 11.3 | 11.3 |
| vtsls frontend RSS | 77.6 | 78.0 |
| Semantic tsserver RSS | 436.5 | 440.2 |
| Separate syntax tsserver RSS | 181.0 | 0 |
| TypeScript typings installer RSS | 66.3 | 66.6 |
| Angular LS RSS | 682.2 | 680.4 |
| Attached ESLint LSP RSS | 0 | 0 |
| Total descendant RSS | 1506.4 | 1323.8 |
| Node processes | 5 | 4 |
| Total processes | 7 | 6 |
| Plugins loaded after opening the file | 30 | 26 |

The reduction is approximately 183 MiB, or 12%. The tested frontend has no ESLint config, so an ESLint LSP correctly does not attach. This is not evidence that ESLint uses no memory in configured projects.

After entering Insert mode, Copilot adds 345.7 MiB before and 345.3 MiB after. Total descendant RSS at that second sample is **1854.1 -> 1672.6 MiB**, and process count is **8 -> 7**. Copilot remains enabled with the same suggestions and mappings. The existing `<leader>at` toggle tears down its client when disabled.

The original lint configuration also started a global `eslint_d` daemon in this frontend despite the absence of an ESLint config. It used about 80 MiB and survived editor exit. A formatting test left a roughly 87-94 MiB prettierd daemon. Those reparented daemons are excluded from the descendant totals above and are reported separately to avoid mixing measurements. All audit-created daemons were stopped. Final checks found no surviving Neovim LSP, eslint_d or prettierd processes after editor exit.

### Startup

Three samples per configuration, empty editor, same binary and pseudo-terminal:

| Measurement | Before | After |
| --- | ---: | ---: |
| UI first-screen elapsed time, median | 156.3 ms | 137.8 ms |
| Headless startup elapsed time, median | 60.1 ms | 21.4 ms |
| LazyDone profile time, median in UI runs | 29.9 ms | 24.9 ms |
| Loaded plugins in idle empty UI | 22 | 16 |
| Registered plugins | 41 | 40 |

UI samples were 156.3/149.7/168.6 ms before and 160.0/132.7/137.8 ms after. The three empty-editor baseline samples replayed a copy of the original configuration in a temporary XDG_CONFIG_HOME, sharing the installed plugin data. Module-cache paths can differ, so these startup results are less controlled than the in-place Angular memory comparison. The pseudo-terminal does not answer the background-color query and introduces terminal negotiation delay. These are comparative measurements, not a prediction of latency in the user's terminal. LazyDone and first-screen elapsed time measure different things. LSP indexing and the memory samples happen later.

Startup was already acceptable. The important changes concern runtime processes and duplicate work, not a few milliseconds of plugin loading.

## TypeScript and Angular decisions

### Keep vtsls, but use one tsserver

The TypeScript extra selected vtsls. `ts_ls` and the old `tsserver` LSP config were disabled by that extra, so installing `typescript-language-server` did not mean it was running. The unused package was removed from both installation policy and the local Mason installation.

`typescript.tsserver.useSyntaxServer = "never"` is supported by the installed vtsls implementation. Its single semantic server handles syntax requests too. Completion, definitions, references, rename, actions, imports, symbols and hints remain available. The tradeoff is that lightweight syntax responses can wait behind initial semantic project loading.

No arbitrary heap cap was added. `--max-old-space-size=3072` is a limit, not a reservation. Lowering it without workload evidence could cause GC pressure or crashes instead of improving memory use.

### Native TypeScript 7 was tested and rejected for now

LazyVim supports `vim.g.lazyvim_ts_lsp = "tsc"`. Its installed tsc config runs `tsc --lsp --stdio`, checks for a version >= 7, and can skip an older project-local binary in favor of a suitable PATH binary. A separate editor server does not require upgrading the project's TypeScript package.

TypeScript 7.0.2 was installed only in a temporary directory and launched with a copy of the original editor config. In the real Angular project it used 174.7 MiB, with 916.9 MiB total descendant RSS before Copilot. Basic completion, hover, definitions, references, rename, hints and workspace symbols returned results. Angular template navigation still came from angularls.

However, it reported actual configuration errors for removed `baseUrl`, removed `moduleResolution=node10`, non-relative `paths`, and the changed `rootDir` requirement. The other two Angular repositories also contain incompatible `baseUrl`/path settings. Replacing the server would therefore change diagnostics without changing the project's compiler behavior. Native code actions did not return the same refactoring choices as vtsls in the sampled location.

Automatic imports were verified on the retained vtsls configuration, not exhaustively on the rejected native configuration. No representative monorepo or project-reference workload was available for a full native regression test. The installed native config has monorepo support, but that is not a measured compatibility guarantee. Revisit the migration only after testing compatible project configurations and the required refactoring workflow. Do not upgrade Angular projects merely to switch the editor server.

### Keep Angular LS, and require an Angular workspace

Angular LS is required for template diagnostics, completion and template/component navigation. It is independent of the Treesitter Angular parser.

Previously Mason auto-enabled this installed server without an explicit user server declaration. Its default config also allowed attachment outside an Angular workspace. `angularls.workspace_required = true` now prevents it from starting in ordinary TypeScript projects. It still attaches to both TypeScript components and templates in Angular projects. Restricting it to HTML alone would break inline-template and component features and was not done.

The server uses a TypeScript engine within ngserver; no separate ngserver child tsserver was observed. Its roughly 680 MiB cost in the Angular sample remains. The Angular extra was not added because its vtsls global-plugin integration would change the existing language-service behavior; the tested standalone angularls integration was retained explicitly instead.

Mason's Angular LS version and the baseline project's Angular version differ. Navigation and completion passed, but exhaustive framework-version compatibility was not established. The other two Angular repositories have no installed node_modules, so complete runtime validation there was not possible without installing project dependencies.

## ESLint and formatting

The user chose to retain ESLint code actions and fixes rather than switch to diagnostics-only eslint_d.

The deleted custom nvim-lint config replaced LazyVim's implementation. nvim-lint itself does not evaluate LazyVim's `condition` extension, so the custom callback ignored the intended ESLint-config gate. It also removed LazyVim's debounce and ran on BufEnter, BufWritePost and InsertLeave. This could start eslint_d alongside the ESLint LSP and leave a daemon after exit.

The same custom spec duplicated Python Ruff diagnostics already provided by the installed Ruff LSP. Removing it restores LazyVim's normal debounced nvim-lint setup. The only current nvim-lint mapping is the default Fish linter.

A real TypeScript backend test reproduced a **roughly 1.3 GiB orphan eslint_d daemon** under the old configuration. This was deliberately produced by an audit probe, not an existing user process. It demonstrates the resource cost of the old path, but is not added to the Angular before/after numbers.

### One pipeline

| Language | Pipeline |
| --- | --- |
| JS/TS and Angular templates | ESLint fixes when an ESLint client supports formatting, then one Prettier pass |
| JSON/YAML/HTML/CSS/SCSS | Prettier |
| Python | Ruff LSP diagnostics/actions; Conform ruff_format |
| Java | Custom jdtls, with LSP formatting fallback and the existing XML profile |
| Lua | LazyVim's StyLua default |
| Shell/Fish | LazyVim's shfmt/fish_indent defaults |

Only LazyVim owns the save hook. The custom Conform `format_on_save` setting was removed; the installed LazyVim already rejects that setting rather than installing a second save hook.

There was a separate formatting bug in the installed LazyVim implementation. The ESLint extra's LSP formatter routed through Conform and selected its configured CLI formatter again. A probe observed two Prettier executions and no ESLint formatting request. The local ESLint setup now registers an LSP-only Conform pass with an empty CLI formatter list, before Conform's normal Prettier pass. This preserves Conform's edit handling and existing autoformat toggles without adding a custom save autocmd.

An editor-only ESLint override disables `prettier/prettier`, so projects that enable eslint-plugin-prettier do not run Prettier inside ESLint too. Other ESLint rules and code actions remain intact. Project ESLint configs were not modified.

The real backend regression test observed **one ESLint formatting request followed by one Prettier execution**, returned ESLint code actions, and changed a temporary `var` declaration to `const`. Buffer contents were restored without writing to disk.

Prettierd was replaced by one-shot Prettier and uninstalled. This removes a persistent daemon at the cost of starting Prettier for each formatting operation. The old prettierd/prettier fallback list already used `stop_after_first`; that list alone did not execute both formatters.

### Remaining memory limit

With the final configuration, a separate real backend workload used about **1415.8 MiB for the ESLint LSP**, **1383.1 MiB for its semantic tsserver**, and **3032.8 MiB total before Copilot**. Angular LS no longer attached there, and neither eslint_d nor a syntax tsserver ran. There is no equivalent stable pre-change total for this backend, so no before/after saving is claimed for it.

That backend's ESLint config explicitly asks the TypeScript parser to load its tsconfig. ESLint and the TypeScript LSP can each retain a large independent program even after editor-side duplication is removed. Likewise, the newer Angular repository enables type-aware ESLint rules. Moving to eslint_d would not remove this parser/program cost. Further reductions would require reviewing project lint configuration or accepting reduced/on-demand analysis. Neither was silently changed in this audit.

## Mason package audit

LSP packages are now driven by explicit server declarations or existing extras instead of a second manual installation list. Current Mason auto-enable behavior still matters: installing a new mapped server can enable it unless it is explicitly disabled. The cleanup controls the current installed set; it is not a general whitelist for future manual installations.

| Package | Decision / owner |
| --- | --- |
| typescript-language-server | Uninstalled; vtsls is the selected server |
| eslint_d | Uninstalled; ESLint LSP is the sole ESLint implementation |
| prettierd | Uninstalled; Conform uses Prettier |
| vtsls | Keep; TypeScript extra |
| angular-language-server | Keep; explicit angularls configuration, not Treesitter |
| eslint-lsp | Keep; ESLint extra and code actions |
| lua-language-server | Keep; LazyVim default server |
| json-lsp, yaml-language-server | Keep; explicitly declared existing IDE support |
| css-lsp, html-lsp | Keep; explicitly declared existing web support |
| dockerfile-language-server, docker-compose-language-service | Keep; explicitly declared existing container support |
| pyright, ruff | Keep; Python types and Ruff diagnostics/actions/formatting |
| jdtls | Keep manual installation; custom nvim-jdtls setup owns startup |
| prettier | Keep manual installation; Conform CLI formatter |
| stylua, shfmt | Keep; LazyVim installs them by default |
| tree-sitter-cli | Keep installed; parser build tool, not an editor LSP |

Installed package count went from 20 to 17. No useful language server was deleted merely because it was absent from the sampled Angular buffer.

## Plugin decisions

| Custom area | Classification | Result |
| --- | --- | --- |
| LSP/Mason/Conform | Keep and simplify | Explicit ownership, one TS engine, one lint strategy, one formatting pipeline |
| Custom nvim-lint spec | Remove | Default plugin stays; ESLint and Ruff LSPs own those diagnostics |
| Treesitter | Keep and simplify | Only extra parsers declared: Dockerfile, Java, Angular, SCSS |
| blink.cmp | Keep | Existing mappings, native snippets and Lua fuzzy matcher unchanged; Rust library is not installed |
| tabout | Optimize loading | InsertEnter trigger; same Alt mappings; unused LuaSnip dependency removed |
| Java logic trainer | Optimize loading | Existing keys and all public commands load it on demand |
| Color highlighting | Optimize loading | LazyFile trigger instead of eager startup |
| todo-comments custom spec | Remove | LazyVim already includes the plugin and mappings |
| Copilot | Keep | Existing InsertEnter loading, suggestions and toggle preserved; substantial RSS documented |
| Gruvbox/lualine | Keep | No theme or layout changes |
| Neo-tree/Snacks | Keep | Existing explorer, picker, dashboard and terminal behavior preserved |
| Render Markdown | Keep | Existing render modes preserved rather than changing editing appearance |
| nvim-jdtls/custom Java config | Keep | Existing navigation, XML formatter and mappings preserved |
| .neoconf.json | Remove | neodev/neoconf settings are obsolete; neither plugin is installed |
| .nvimlog | Remove and ignore | Generated runtime log, not configuration |

LazyVim's default navigation, completion, text objects, diagnostics UI, Git integration and session plugins remain. No new plugin was added. Treesitter parsers installed on disk do not all consume memory in every buffer, so existing parsers were not mass-uninstalled.

The obsolete Treesitter `incremental_selection` table did nothing on the installed main branch. LazyVim's Flash mappings already implement the working Ctrl-Space/Backspace selection workflow. Highlighting, indentation and semantic tokens were retained. No custom query files were found.

Theme-related autocmds do small highlight updates, not external work, and were not refactored for negligible savings. Terminal cleanup moved from QuitPre to VimLeavePre so closing an unrelated window no longer kills all terminal jobs; jobstop is guarded for already-exited jobs.

The initial TypeScript/Angular audit left Java's `-Xms1g` launcher and XML untouched. The Java follow-up below fixes those separately. The old XML was an IntelliJ code scheme, not an Eclipse formatter profile, so its two-space settings were not a valid jdtls formatter configuration.

## Verification and limits

Passed before/after on the real Angular workload:

- Existing unused-import diagnostics and an injected type error.
- Completion and hover requests.
- Definition, references and rename requests. Rename edits were inspected, not applied.
- TypeScript code actions, inlay hints and workspace symbols.
- Automatic-import completion resolution with additional import edits.
- Template completion/hover/definition and template-to-component navigation.
- Component templateUrl-to-template navigation through Angular LS.
- Conform formatting invocation and formatter availability.

Additional final checks passed for the real backend's ESLint diagnostics, code actions, autofix and single-pass formatting; first-use Tabout mappings; Java trainer command lazy loading; terminal survival when closing an unrelated window; Lua syntax; and changed-file formatting checks. The pre-existing Tabout setup-call style does not match StyLua's preferred parentheses and was left unchanged rather than reformatted cosmetically.

Full checkhealth ran before and after. It still reports missing optional providers, LuaRocks tools, diagram/LaTeX renderers and terminal-image support in the simulated terminal. The obsolete LuaSnip-related warning is gone. No new required LSP/parser error was introduced. Optional providers/renderers were not installed just to make health output entirely green.

Repository verification:

- `git diff --check`: passed.
- `scripts/preflight.sh --dry-run`: passed.
- `scripts/check.sh`: attempted, but fails on the unrelated missing `hypr/.config/hypr/scripts/lid_handler.sh` target; ShellCheck is also not installed. No unrelated dotfiles were changed to hide this failure.

Interactive completion-menu behavior, arbitrary refactorings, all Angular-version combinations, monorepos and tsconfig-reference workloads were not exhaustively tested. LSP protocol responses and representative actions passed, but this audit does not claim universal feature coverage or a guaranteed RSS ceiling.

## Java follow-up

The user requested the remaining Java, explorer and Markdown improvements, excluding changes to ESLint, Copilot activation and Angular LS. Those excluded areas were not changed in this follow-up.

### Attachment and lifecycle

The original `nvim-jdtls` plugin config called setup once when the plugin loaded. A real Maven-project test confirmed one client on the first Java buffer, no client on a second buffer in the same project, and no client on a buffer from a second Maven project.

Setup now runs from `ftplugin/java.lua` for every Java buffer. The same test confirmed two buffers sharing the first project's client, a separate client/workspace for the second project, and no duplicate client when setup runs again on the first buffer. Existing organize-imports and extraction mappings remain buffer-local. Both server processes exited after Neovim closed.

### Heap and measured memory

The initial/minimum heap changed from `-Xms1g` to `-Xms256m`. No restrictive maximum heap or custom GC flags were added; larger workloads can still grow the heap.

An initial cold import was not used as the comparison baseline because it downloaded Maven dependencies and initialized indexes. The original configuration was replayed with warm dependency/workspace caches, then the new configuration opened the same real Java 21 Maven project and enum. Both samples were taken after 45 seconds, before opening the second project.

| Single-project measurement | Warm original config | New config |
| --- | ---: | ---: |
| jdtls process RSS | 836.9 MiB | 474.3 MiB |
| Committed Java heap from jcmd | 1024 MiB | 256 MiB |
| Used Java heap from jcmd | 138.4 MiB | 149.9 MiB |

The observed RSS reduction was 362.6 MiB, approximately 43%. These are single snapshots after warm startup, not peak-memory or large-project guarantees. Opening two projects correctly starts two JVMs; the formerly broken second-project attachment must not be counted as a memory optimization.

### IntelliJ-like formatting with four spaces

The old XML had IntelliJ's `component/code_scheme` structure. jdtls logged that the requested `IntelliJ` profile did not exist. After discussing the dependency tradeoff, the user chose an Eclipse profile approximating the existing IntelliJ style, rather than installing the IntelliJ formatter engine.

`lua/config/java-style.xml` is now a valid Eclipse `CodeFormatterProfile` named `IntelliJ`. It uses spaces, four-space indentation, eight-space continuation indentation, the existing 140-column width, same-line opening braces, and preserves the old scheme's newline-before-else/catch/finally choices where representable. It is not the exact JetBrains formatter and does not reproduce IntelliJ's member-arrangement rules. No formatter dependency or extra JVM was added.

A Conform-to-jdtls test reformatted an unsaved Java sample and confirmed four-space nesting without tabs, plus the distinctive newline-before-else setting. The original buffer was restored without saving. Formatter option identifiers were checked against the installed Eclipse JDT constants.

Java completion, hover, definition, references, rename edits, organize-imports code actions and existing Java mappings returned valid results. An injected String-to-int assignment produced a diagnostic and was removed without saving. LSP health output showed both project clients attached to their respective buffers.

### Explorers and Markdown

Neo-tree and the Snacks explorer exclude `.git`, `node_modules`, `.angular`, `dist`, `coverage`, `target` and `build` directories. Dotfiles and other gitignored files remain visible, including `.env`. These exclusions affect the explorer views, not the general file picker or the filesystem. Tests exercised the actual Snacks filter and resolved Neo-tree settings.

Render Markdown now uses its normal `n`, `c` and `t` render modes, not Insert mode. Rendering while actively inserting text is intentionally disabled. No Markdown latency saving is claimed because it was not benchmarked.

Lua syntax, changed-file StyLua checks, XML parsing, explorer/Markdown configuration checks and `git diff --check` passed. Preflight passed again. The repository-wide check remains blocked by the unrelated missing Hyprland script and unavailable ShellCheck noted above. Java follow-up artifacts are in `/tmp/nvim-java-audit/`.
