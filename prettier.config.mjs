/** @type {import('prettier').Config} */
export default {
  // Match the two-space indentation used throughout data-pipeline.
  tabWidth: 2,
  // Use spaces, consistent with the existing TypeScript and HTML sources.
  useTabs: false,
  // Keep lines readable without forcing the existing code into a narrow column.
  printWidth: 100,
  // Preserve the semicolon style used by the pipeline utilities and UI scripts.
  semi: true,
  // Prefer double quotes, as used by the pipeline's TypeScript imports and utilities.
  singleQuote: false,
  // Keep trailing commas in multiline calls and objects, matching pipeline utilities.
  trailingComma: "all",
  // Retain parentheses around arrow parameters, matching typed server callbacks.
  arrowParens: "always",
  // Keep spaces inside object braces, matching existing imports and object literals.
  bracketSpacing: true,
  // Use consistent Linux/CI line endings across the monorepo.
  endOfLine: "lf",
  // Preserve whitespace significance in inline HTML rather than treating all tags alike.
  htmlWhitespaceSensitivity: "css",
  // Leave hand-wrapped prose alone; formatting code should not reflow documentation.
  proseWrap: "preserve",
};
