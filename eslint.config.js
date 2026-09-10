import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "**/temp/**",
      "**/tmp/**",
      "**/.tmp/**",
      "**/.temp/**",
      "**/.lh/**",
      "**/.history/**",
      "**/.cache/**",
      "design/**",
      "coverage/**",
      "docs/.vitepress/cache/**",
      "docs/.vitepress/dist/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "examples/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error"
    }
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.mts", "*.ts", "docs/**/*.ts", "tests/consumer/**/*.ts"],
    ...tseslint.configs.disableTypeChecked,
  }
);
