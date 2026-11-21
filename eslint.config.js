import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      // @coral-xyz/anchor is CommonJS: Node 22's ESM loader cannot see `BN` among its named exports,
      // so `import { BN } from "@coral-xyz/anchor"` crashes the published server at startup on
      // Node 22 (the minimum we support) while passing on newer Node. Shipped in 0.9.0 and 0.10.0.
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@coral-xyz/anchor",
              importNames: ["BN"],
              allowTypeImports: true,
              message: 'Import BN from "bn.js" — Node 22 cannot load it from anchor (CommonJS).',
            },
          ],
        },
      ],
      "prefer-const": "warn",
    },
  },
  prettier,
);
