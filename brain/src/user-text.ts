// The rule for words users read or hear (scripts/lint-user-text.mjs; Jordan, 3 November 2026): nothing names the AI
// provider or a model, so either can change. Pure, so the lint, and Ops checking a banner before it's saved, share it.
export const FORBIDDEN = /\b(open\s?ai|chat\s?gpt|gpt(?:[-\s.]?[a-z0-9.]+)?|luna|sol)\b/i;
