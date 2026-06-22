## Conventions

### Tooling

- Use `bun` as the package manager. Run tests with `bun run test` (vitest).
- Minimize introducing new dependencies unless necessary and agreed upon.

### Code Organization

- Don't break code up into too many functions unless there is a need to make it composable or reusable.
- Avoid splitting code across multiple directories or too many files.
- Do not worry about optimizing for code reuse until there are clear examples - e.g. at least 2+, or where code is interacting with external systems.
- Keep functions related to external APIs in their respective files (for example, GitHub code belongs in `github.ts`).

### Comments

- Comments should focus on the _why_, not the _what_. Don't comment on short (<10 line) functions or variable declarations.
- Prioritize comments for code that is across I/O boundaries (e.g. API calls), orchestrates external systems, or contains state.

### Testing

- Keep tests focused on user input, API calls/interface validation, and crash resistance. More tests are not better.

### Configuration

- Prefer JSONC for config unless otherwise indicated or required to meet an existing dependency.
