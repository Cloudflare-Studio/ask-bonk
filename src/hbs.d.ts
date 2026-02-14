// Build-time constants injected via wrangler --define flags (see package.json deploy script)
declare const __VERSION__: string;
declare const __COMMIT__: string;

declare module "*.hbs" {
  const content: string;
  export default content;
}

// Wrangler uses "rules" with type: "Text" for non-JS assets (not Vite's ?raw suffix)
// See: wrangler.jsonc rules configuration
declare module "*.sql" {
  const content: string;
  export default content;
}
