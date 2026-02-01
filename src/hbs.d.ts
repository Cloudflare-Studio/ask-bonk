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
